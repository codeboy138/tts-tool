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

export default {
  async fetch(request, env) {
    // CORS Preflight 처리
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders() });
    }

    if (request.method !== 'POST') {
      return new Response(JSON.stringify({ error: 'POST 요청만 허용됩니다.' }), {
        status: 405,
        headers: { ...corsHeaders(), 'Content-Type': 'application/json' }
      });
    }

    let body;
    try {
      body = await request.json();
    } catch (e) {
      return jsonError('요청 본문이 올바른 JSON이 아닙니다.', 400);
    }

    const text = (body.text || '').trim();
    const voiceName = body.voiceName || 'Kore';

    if (!text) {
      return jsonError('text 필드가 비어 있습니다.', 400);
    }

    const apiKey = env.GEMINI_API_KEY;
    if (!apiKey) {
      return jsonError('서버에 GEMINI_API_KEY 시크릿이 설정되어 있지 않습니다. (wrangler secret put GEMINI_API_KEY)', 500);
    }

    const model = 'gemini-2.5-flash-preview-tts';
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

    const payload = {
      contents: [{ parts: [{ text }] }],
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName }
          }
        }
      }
    };

    let geminiRes;
    try {
      geminiRes = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
    } catch (e) {
      return jsonError(`Gemini API 호출 실패: ${e.message}`, 502);
    }

    if (!geminiRes.ok) {
      const errText = await geminiRes.text();
      return jsonError(`Gemini API 오류 (HTTP ${geminiRes.status}): ${errText}`, 502);
    }

    const data = await geminiRes.json();
    const part = data?.candidates?.[0]?.content?.parts?.[0];
    const base64Audio = part?.inlineData?.data;
    const mimeType = part?.inlineData?.mimeType || 'audio/L16;rate=24000';

    if (!base64Audio) {
      return jsonError('Gemini 응답에서 오디오 데이터를 찾을 수 없습니다.', 502);
    }

    // base64 -> PCM 바이너리
    const pcmBinary = base64ToUint8Array(base64Audio);

    // mimeType(예: "audio/L16;rate=24000")에서 샘플레이트 추출
    const rateMatch = /rate=(\d+)/.exec(mimeType);
    const sampleRate = rateMatch ? parseInt(rateMatch[1], 10) : 24000;

    const wavBuffer = pcmToWav(pcmBinary, sampleRate, 1, 16);

    return new Response(wavBuffer, {
      headers: {
        ...corsHeaders(),
        'Content-Type': 'audio/wav'
      }
    });
  }
};

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  };
}

function jsonError(message, status) {
  return new Response(JSON.stringify({ error: message }), {
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

// Gemini가 반환하는 raw PCM(16bit, mono) 데이터에 WAV 헤더를 씌워
// 브라우저 <audio> 태그와 일반 미디어 플레이어에서 바로 재생 가능한 파일로 만듭니다.
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
