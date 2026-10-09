// The document etched into the glass. Ordinary HTML: real checkboxes behind
// the toggles, a real text input, real buttons with hover and active states,
// and two CSS animations so the texture keeps moving after the pane breaks.
// The stylesheet is a <style> element inside the document; it applies once
// the tree is connected to the Sandom document.

export const DOCUMENT_WIDTH = 640;
export const DOCUMENT_HEIGHT = 800;

const DOCUMENT_CSS = `
main {
  display: flex;
  flex-direction: column;
  gap: 14px;
  box-sizing: border-box;
  width: ${DOCUMENT_WIDTH}px;
  height: ${DOCUMENT_HEIGHT}px;
  padding: 22px 28px;
  background-color: #0f141b;
  color: #e6edf3;
  font-family: "Inter";
  font-size: 17px;
}

.top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding-bottom: 6px;
}

.brand {
  display: flex;
  align-items: center;
  gap: 10px;
  font-family: "IBM Plex Mono";
  font-size: 15px;
  letter-spacing: 0.08em;
  color: #9fd8c8;
}

.pulse {
  display: inline-block;
  width: 10px;
  height: 10px;
  border-radius: 5px;
  background-color: #3ddc97;
  animation: pulse 1.6s ease-in-out infinite;
}

@keyframes pulse {
  0% { transform: scale(0.7); opacity: 0.5; }
  50% { transform: scale(1.25); opacity: 1; }
  100% { transform: scale(0.7); opacity: 0.5; }
}

.muted {
  color: #7d8895;
  font-size: 14px;
}

.card {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 18px 20px;
  border: 1px solid #1f2733;
  border-radius: 14px;
  background-color: #151c25;
}

h1 {
  margin: 0 0 4px;
  font-size: 14px;
  font-weight: 600;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: #8fa3b8;
}

.row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 38px;
  padding: 0 4px;
  border-radius: 8px;
  cursor: pointer;
}

.row:hover {
  background-color: #1b2430;
}

.row input {
  position: absolute;
  width: 0;
  height: 0;
  opacity: 0;
}

.track {
  position: relative;
  display: block;
  width: 46px;
  height: 26px;
  border-radius: 13px;
  background-color: #2a3442;
  transition: background-color 180ms ease;
}

.track::before {
  content: "";
  position: absolute;
  top: 3px;
  left: 3px;
  width: 20px;
  height: 20px;
  border-radius: 10px;
  background-color: #e6edf3;
  transition: transform 180ms ease;
}

.row input:checked + .track {
  background-color: #3ddc97;
}

.row input:checked + .track::before {
  transform: translateX(20px);
}

.field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 14px;
  color: #8fa3b8;
}

.field input {
  box-sizing: border-box;
  height: 42px;
  padding: 0 12px;
  border: 1px solid #2a3442;
  border-radius: 8px;
  background-color: #0f141b;
  color: #e6edf3;
  font-family: "Inter";
  font-size: 17px;
}

.field input:hover {
  border-color: #3a4757;
}

.field input:focus {
  border-color: #3ddc97;
  outline: none;
}

.segment {
  display: flex;
  margin-top: 4px;
  border: 1px solid #2a3442;
  border-radius: 8px;
  overflow: hidden;
}

.segment label {
  display: flex;
  flex: 1 1 0px;
  cursor: pointer;
}

.segment input {
  position: absolute;
  width: 0;
  height: 0;
  opacity: 0;
}

.segment span {
  flex: 1 1 0px;
  padding: 9px 0;
  text-align: center;
  font-size: 15px;
  color: #8fa3b8;
  transition: background-color 120ms ease, color 120ms ease;
}

.segment label:hover span {
  background-color: #1b2430;
}

.segment input:checked + span {
  background-color: #243041;
  color: #e6edf3;
}

.bar {
  position: relative;
  height: 10px;
  border-radius: 5px;
  background-color: #2a3442;
  overflow: hidden;
}

.fill {
  position: absolute;
  top: 0;
  left: 0;
  width: 40%;
  height: 10px;
  border-radius: 5px;
  background-color: #3ddc97;
  animation: sweep 2.4s ease-in-out infinite alternate;
}

@keyframes sweep {
  from { transform: translateX(0); }
  to { transform: translateX(150%); }
}

.actions {
  display: flex;
  gap: 12px;
  margin-top: auto;
}

button {
  flex: 1 1 0px;
  height: 48px;
  border: 1px solid #2a3442;
  border-radius: 10px;
  background-color: #151c25;
  color: #e6edf3;
  font-family: "Inter";
  font-size: 16px;
  font-weight: 600;
  cursor: pointer;
  transition: background-color 120ms ease, transform 120ms ease;
}

button.primary {
  border-color: #3ddc97;
  background-color: #3ddc97;
  color: #0b1a14;
}

button.primary:hover {
  background-color: #63e6ad;
}

button.ghost:hover {
  background-color: #1b2430;
}

button:active {
  transform: scale(0.97);
}
`;

export const DOCUMENT_HTML = `
<style>${DOCUMENT_CSS}</style>
<header class="top">
  <div class="brand"><span class="pulse"></span>sandom / glass</div>
  <div class="muted">settings · pane 01</div>
</header>
<section class="card">
  <h1>Display</h1>
  <label class="row"><span>Night mode</span><input type="checkbox" checked><span class="track"></span></label>
  <label class="row"><span>Reduce motion</span><input type="checkbox"><span class="track"></span></label>
  <label class="row"><span>High contrast</span><input type="checkbox"><span class="track"></span></label>
  <label class="row"><span>Show pointer trails</span><input type="checkbox" checked><span class="track"></span></label>
</section>
<section class="card">
  <h1>Account</h1>
  <label class="field"><span>Display name</span><input type="text" value="Ada Lovelace"></label>
  <label class="field"><span>Handle</span><input type="text" value="@ada"></label>
  <div class="segment">
    <label><input type="radio" name="theme" checked><span>Auto</span></label>
    <label><input type="radio" name="theme"><span>Light</span></label>
    <label><input type="radio" name="theme"><span>Dark</span></label>
  </div>
</section>
<section class="card">
  <h1>Sync</h1>
  <div class="bar"><span class="fill"></span></div>
  <div class="muted">Uploading library · 3 of 12 albums</div>
</section>
<footer class="actions">
  <button class="primary">Save changes</button>
  <button class="ghost">Discard</button>
</footer>
`;
