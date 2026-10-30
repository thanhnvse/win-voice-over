// Settings shared by the content script, the popup and the background worker. Each loads
// this as a classic script, so it only sets one global.
globalThis.WVO = {
  DEFAULTS: {
    enabled: true,
    // 'browser' speaks with speechSynthesis; 'gemini' with the Gemini TTS API.
    engine: 'browser',
    voiceURI: '',
    rate: 1.1,
    duck: 0.3,
    geminiModel: 'gemini-3.8-flash-tts',
    geminiVoice: 'Kore',
    // Gemini reads `style` as a direction, not as text to speak. Its docs describe styles
    // in English, which also works for a Vietnamese transcript.
    geminiStyle: 'an expressive voice actor dubbing a TV drama: match the emotion of the line, '
      + 'natural Vietnamese, brisk pace',
  },

  // Sites whose subtitles are burned into the picture, so OCR is on unless switched off.
  OCR_DEFAULT_HOSTS: /motchill/i,

  // Models from the Gemini speech docs that list Vietnamese and have a free tier.
  GEMINI_MODELS: [
    { id: 'gemini-3.8-flash-tts', label: 'Gemini 3.8 Flash TTS' },
    { id: 'gemini-3.8-flash-lite-tts', label: 'Gemini 3.8 Flash-Lite TTS (cheaper)' },
  ],

  // The 30 prebuilt voices, with the character the Gemini docs give each one.
  GEMINI_VOICES: [
    ['Zephyr', 'Bright'], ['Puck', 'Upbeat'], ['Charon', 'Informative'], ['Kore', 'Firm'],
    ['Fenrir', 'Excitable'], ['Leda', 'Youthful'], ['Orus', 'Firm'], ['Aoede', 'Breezy'],
    ['Callirrhoe', 'Easy-going'], ['Autonoe', 'Bright'], ['Enceladus', 'Breathy'],
    ['Iapetus', 'Clear'], ['Umbriel', 'Easy-going'], ['Algieba', 'Smooth'], ['Despina', 'Smooth'],
    ['Erinome', 'Clear'], ['Algenib', 'Gravelly'], ['Rasalgethi', 'Informative'],
    ['Laomedeia', 'Upbeat'], ['Achernar', 'Soft'], ['Alnilam', 'Firm'], ['Schedar', 'Even'],
    ['Gacrux', 'Mature'], ['Pulcherrima', 'Forward'], ['Achird', 'Friendly'],
    ['Zubenelgenubi', 'Casual'], ['Vindemiatrix', 'Gentle'], ['Sadachbia', 'Lively'],
    ['Sadaltager', 'Knowledgeable'], ['Sulafat', 'Warm'],
  ],

  // Turns the background worker's { data: base64, mimeType } reply into a playable blob.
  audioBlob({ data, mimeType }) {
    return new Blob([Uint8Array.from(atob(data), (c) => c.charCodeAt(0))], { type: mimeType });
  },
};
