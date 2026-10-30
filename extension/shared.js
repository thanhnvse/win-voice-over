// Settings shared by the content script, the popup and the background worker. Each loads
// this as a classic script, so it only sets one global.
globalThis.WVO = {
  DEFAULTS: {
    enabled: true,
    // 'browser' speaks with speechSynthesis; 'gemini' and 'azure' with a cloud TTS API;
    // 'vieneu' with a VieNeu-TTS server on this computer.
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
    // Must be the region of the user's Speech resource; Southeast Asia is the closest to Vietnam.
    azureRegion: 'southeastasia',
    azureVoice: 'vi-VN-HoaiMyNeural',
    vieneuVoice: 'Trúc Ly',
  },

  // Engines that synthesise in the background worker and answer with audio, with the name
  // shown in messages.
  AUDIO_ENGINES: { gemini: 'Gemini TTS', azure: 'Azure TTS', vieneu: 'VieNeu' },

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

  // The Vietnamese neural voices; Edge's "Online (Natural)" voices are these two.
  AZURE_VOICES: [
    ['vi-VN-HoaiMyNeural', 'HoaiMy (female)'],
    ['vi-VN-NamMinhNeural', 'NamMinh (male)'],
  ],

  // The 25 preset voices of VieNeu-TTS v3 Turbo, as its GET /v1/voices lists them.
  VIENEU_VOICES: [
    ['Trúc Ly', 'female, Northern, natural'], ['Hải Đăng', 'male, Northern, natural'],
    ['Adam bựa', 'male, Northern, natural'], ['Thiện Minh', 'male, Northern, storytelling'],
    ['Mai Anh', 'female, Northern, news'], ['Thùy Dung', 'female, Southern, news'],
    ['Thiền Tâm Đức', 'male, Northern, storytelling'],
    ['Ngọc Huyền', 'female, Northern, natural'], ['Quang Sơn', 'male, Central, natural'],
    ['Ngọc Trân', 'female, Central, natural'], ['Minh Đức', 'male, Northern, news'],
    ['Phạm Tuyên', 'male, Northern, natural'], ['Thái Sơn', 'male, Southern, storytelling'],
    ['Xuân Vĩnh', 'male, Northern, natural'], ['Thanh Bình', 'male, Northern, storytelling'],
    ['Ngọc Linh', 'female, Northern, storytelling'], ['Đoan Trang', 'female, Northern, natural'],
    ['Thục Đoan', 'female, Southern, storytelling'], ['Minh Triết', 'male, Southern, news'],
    ['Mỹ Duyên', 'female, Southern, story reading'],
    ['Quỳnh Anh', 'female, Northern, story reading'],
    ['Đức Trí', 'male, Southern, story reading'],
    ['Kim Thanh', 'female, Southern, story reading'], ['Adam', 'male, Southern, natural'],
    ['Quốc Tuấn', 'male, Northern, natural'],
  ],

  // Turns the background worker's { data: base64, mimeType } reply into a playable blob.
  audioBlob({ data, mimeType }) {
    return new Blob([Uint8Array.from(atob(data), (c) => c.charCodeAt(0))], { type: mimeType });
  },
};
