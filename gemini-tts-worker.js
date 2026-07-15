/**
 * Cloudflare Worker: Gemini TTS 프록시
 * -----------------------------------------------------
 * 역할: 브라우저(프론트엔드)가 이 Worker로 텍스트를 보내면,
 *       Worker가 Gemini API 키(시크릿)를 사용해 Google Gemini TTS를 호출하고,
 *       결과 오디오를 WAV 파일로 변환해서 돌려줍니다.
 *       API 키는 절대 브라우저(클라이언트)에 노출되지 않습니다.
 *
 * 배포 방법 (Cloudflare 계정 필요, wrangler CLI 사용):
 *   1) npm install -g wrangler
 *   2) wrangler login
 *   3) 이 파일을 폴더에 두고 (예: gemini-tts-worker.js) 같은 폴더에 wrangler.toml 작성:
 *
 *        name = "gemini-tts-worker"
 *        main = "gemini-tts-worker.js"
 *        compatibility_date = "2026-07-01"
 *
 *   4) API 키를 시크릿으로 등록 (터미널에 입력하면 프롬프트가 뜹니다. 코드/파일에는 저장되지 않음):
 *        wrangler secret put GEMINI_API_KEY
 *
 *   5) 배포:
 *        wrangler deploy
 *
 *   6) 배포 후 나오는 주소 (예: https://gemini-tts-worker.<your-subdomain>.workers.dev)를
 *      HTML 화면의 "Cloudflare Worker 엔드포인트 URL" 칸에 입력하면 됩니다.
 *
 * 주의: 아래 CORS 설정은 Access-Control-Allow-Origin: '*' 로 열어뒀습니다.
 *       특정 도메인에서만 호출되게 하려면 '*' 대신 실제 도메인으로 제한하세요.
 */

/**
 * Cloudflare Worker: Gemini TTS 프록시 (리팩토링 버전)
 * -----------------------------------------------------
 * 역할: 클라이언트의 요청(Text, Voice, Instruction)을 받아
 * Gemini API에 TTS 생성을 지시하고 결과를 WAV로 반환합니다.
 * 향후 여러 엔진(Edge, Google Cloud) 추가를 고려하여 구조화되었습니다.
 */

export default {
  async fetch(request, env) {
    // CORS Preflight 처리
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders() });
    }

    if (request.method !== 'POST') {
      return jsonError('POST 요청만 허용됩니다.', 405);
    }

    let body;
    try {
      body = await request.json();
    } catch (e) {
      return jsonError('요청 본문이 올바른 JSON이 아닙니다.', 400);
    }

    const engine = body.engine || 'gemini'; // 향후 엔진 분기를 위함

    if (engine === 'gemini') {
      return await handleGeminiTTS(body, env);
    } else {
      return jsonError(`지원하지 않는 엔진입니다: ${engine}`, 400);
    }
  }
};

/**
 * Gemini TTS 엔진 처리기
 */
async function handleGeminiTTS(body, env) {
  const text = (body.text || '').trim();
  const voiceName = body.voiceName || 'Kore';
  const instruction = (body.instruction || '').trim();

  if (!text) {
    return jsonError('text 필드가 비어 있습니다.', 400);
  }

  const apiKey = env.GEMINI_API_KEY;
  if (!apiKey) {
    return jsonError('서버에 GEMINI_API_KEY 시크릿이 설정되어 있지 않습니다.', 500);
  }

  const model = 'gemini-2.5-flash-preview-tts';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  // 지시문(Instruction)을 Prompt 구조에 통합
  let promptText = '';
  if (instruction) {
    promptText = `Speech Style: ${instruction}\n\nScript: ${text}`;
  } else {
    promptText = text;
  }

  const payload = {
    contents: [{ parts: [{ text: promptText }] }],
    generationConfig: {
      responseModalities: ['AUDIO'],
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: { voiceName }
        }
      }
    }
  };

  // Fetch with Timeout 구현 (워커 수준의 Timeout 안전장치, 30초)
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30000);

  let geminiRes;
  try {
    geminiRes = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    clearTimeout(timeoutId);
  } catch (e) {
    clearTimeout(timeoutId);
    if (e.name === 'AbortError') {
      return jsonError('Gemini API 호출 시간 초과 (Timeout)', 504);
    }
    return jsonError(`Gemini API 호출 네트워크 실패: ${e.message}`, 502);
  }

  // HTTP 에러 처리
  if (!geminiRes.ok) {
    let errText = await geminiRes.text();
    try {
      // JSON 에러면 파싱해서 더 보기 좋게 만듦
      const errObj = JSON.parse(errText);
      if (errObj.error && errObj.error.message) {
        errText = errObj.error.message;
      }
    } catch (_) {}
    return jsonError(`Gemini API 오류 (HTTP ${geminiRes.status}): ${errText}`, 502);
  }

  // 응답 데이터 검증
  let data;
  try {
    data = await geminiRes.json();
  } catch (e) {
    return jsonError('Gemini API 응답을 JSON으로 파싱할 수 없습니다.', 502);
  }

  const part = data?.candidates?.[0]?.content?.parts?.[0];
  const base64Audio = part?.inlineData?.data;
  const mimeType = part?.inlineData?.mimeType || 'audio/L16;rate=24000';

  if (!base64Audio) {
    // 거절(FinishReason: RECITATION, SAFETY 등) 확인
    const finishReason = data?.candidates?.[0]?.finishReason;
    if (finishReason) {
      return jsonError(`Gemini가 콘텐츠 생성을 거부했습니다. (FinishReason: ${finishReason})`, 500);
    }
    return jsonError('Gemini 응답에서 오디오 데이터를 찾을 수 없습니다. (비정상 응답 구조)', 502);
  }

  // base64 -> PCM 바이너리 변환
  const pcmBinary = base64ToUint8Array(base64Audio);

  // mimeType(예: "audio/L16;rate=24000")에서 샘플레이트 추출
  const rateMatch = /rate=(\d+)/.exec(mimeType);
  const sampleRate = rateMatch ? parseInt(rateMatch[1], 10) : 24000;

  // PCM -> WAV 헤더 씌우기
  const wavBuffer = pcmToWav(pcmBinary, sampleRate, 1, 16);

  return new Response(wavBuffer, {
    headers: {
      ...corsHeaders(),
      'Content-Type': 'audio/wav',
      'X-Generated-Length': pcmBinary.length.toString()
    }
  });
}

// --- 공통 유틸리티 함수 ---

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  };
}

function jsonError(message, status) {
  return new Response(JSON.stringify({ error: message, success: false }), {
    status,
    headers: { ...corsHeaders(), 'Content-Type': 'application/json' }
  });
}

function base64ToUint8Array(base64) {
  const binaryString = atob(base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

// 16bit mono PCM 데이터를 WAV 형식으로 변환
function pcmToWav(pcmData, sampleRate, numChannels, bitsPerSample) {
  const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
  const blockAlign = numChannels * (bitsPerSample / 8);
  const dataSize = pcmData.length;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  writeString(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeString(view, 8, 'WAVE');
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM format
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  writeString(view, 36, 'data');
  view.setUint32(40, dataSize, true);

  const wavBytes = new Uint8Array(buffer);
  wavBytes.set(pcmData, 44);

  return wavBytes.buffer;
}

function writeString(view, offset, string) {
  for (let i = 0; i < string.length; i++) {
    view.setUint8(offset + i, string.charCodeAt(i));
  }
}
