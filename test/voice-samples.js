// Each line exercises one emotion; the last one checks Sino-Vietnamese words common in dramas.
const LINES = [
  'Hôm nay trời đẹp quá, mình đi dạo nhé!',
  'Anh có chắc là chuyện này sẽ ổn không?',
  'Đủ rồi! Tôi không muốn nghe thêm bất cứ lời nào nữa!',
  'Ta sẽ không bao giờ quên những gì người đã làm cho ta.',
  'Suỵt… có người đang đến, đừng lên tiếng.',
  'Bẩm hoàng thượng, thần có tội, xin người tha mạng!',
];
const $ = (id) => document.getElementById(id);

function fillVoices() {
  const voices = speechSynthesis.getVoices();
  const vi = voices.filter((v) => v.lang.toLowerCase().startsWith('vi'));
  $('voice').innerHTML = '';
  for (const v of [...vi, ...voices.filter((v) => !vi.includes(v))]) {
    $('voice').add(new Option(`${v.name} (${v.lang})`, v.voiceURI));
  }
}

function utterance(text) {
  const u = new SpeechSynthesisUtterance(text);
  const voice = speechSynthesis.getVoices().find((v) => v.voiceURI === $('voice').value);
  if (voice) u.voice = voice;
  u.lang = voice ? voice.lang : 'vi-VN';
  u.rate = Number($('rate').value);
  return u;
}

for (const text of LINES) {
  const li = document.createElement('li');
  const play = document.createElement('button');
  play.textContent = 'Play';
  play.onclick = () => { speechSynthesis.cancel(); speechSynthesis.speak(utterance(text)); };
  const span = document.createElement('span');
  span.textContent = text;
  li.append(play, span);
  $('lines').append(li);
}
$('all').onclick = () => { speechSynthesis.cancel(); LINES.forEach((t) => speechSynthesis.speak(utterance(t))); };
$('stop').onclick = () => speechSynthesis.cancel();
fillVoices();
speechSynthesis.addEventListener('voiceschanged', fillVoices);
