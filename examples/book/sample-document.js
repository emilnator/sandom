// Documents the page editor can load: ordinary HTML and CSS, cut into pages
// by flow.js. The essay is flowing prose; the website is a small static
// site with a responsive grid, a form and an inline script.

export const ESSAY_HTML = `<h1>On Paper</h1>
<p class="subtitle">Notes on fibre, ink and the turning leaf</p>

<h2>The Weight of a Leaf</h2>
<p>Pick up a sheet of good paper and it answers the hand before the eye. It has a weight, a stiffness, a faint tooth under the thumb; it resists being bent and then gives, all at once, in a long curve that runs from the fingers to the far edge.</p>
<p>Grammage is the paper maker's word for that weight: grams to the square metre. Heavier stock is thicker, and a sheet's stiffness grows with the cube of its thickness, so a leaf of heavy paper turns slowly and deliberately where a thin one flutters.</p>
<p>Air matters more than we notice. A falling leaf pushes the air beneath it aside, and near the stack the air has nowhere to go; the page floats the last few millimetres down on a cushion of its own making.</p>
<blockquote>A page is a door that closes behind you, softly, and waits.</blockquote>
<p>The spine holds every leaf along one line. Near it the pages rise to meet the binding in a curve, and the thicker the book, the deeper that gutter and the further the fore edge draws in toward the middle.</p>
<p>Hold the page up to the light and the other side shows through, reversed, faint as a watermark. Paper is not a surface but a thin felt of fibres, and light wanders through it before it finds its way out again.</p>

<h2>Fibre and Formation</h2>
<p>Cotton fibres are long and nearly pure cellulose; wood pulp is shorter and carries lignin that yellows in the sun. A sheet formed on a wire mould keeps the pattern of that mould: the fine parallel lines of a laid paper, the even mesh of a wove.</p>
<p>Formation is how evenly the fibres settled. Look through a sheet at a lamp and a poor one is cloudy, flocks of fibre drifting like weather; a good one is calm, the grain of it too fine to name.</p>
<p>The fibres also have a direction. As the web runs down the machine they line up with it, and the sheet bends more easily across the grain than along it. A book bound with the grain parallel to the spine opens flat and turns cleanly; bound against it, the pages fight the hand and ripple at the gutter when the air is damp.</p>
<p>Sizing decides how ink behaves on the surface. An unsized sheet drinks the ink and the letters spread into soft blots; a hard-sized one holds each stroke where the type put it, sharp enough to read the counter of a small italic e.</p>

<h2>Ink on the Page</h2>
<p>Ink does not sit on paper like paint on a wall. It sinks a little way into the felt, and the light that reaches the eye has passed through it twice: once on the way in, once on the way out again after scattering among the fibres beneath.</p>
<p>That is why black on uncoated stock is never quite black, and why a colour printed on cream is warmer than the same colour on white. The paper is always part of the picture.</p>
<p>A typesetter works in that knowledge. Letters that look right on a screen, lit from behind, look thin when the light must cross the ink twice, so book faces carry a little more weight in their strokes than the faces made for glass.</p>
<p>The margins are part of the design too. The inner margin is narrow because the two pages of a spread are read as one field; the outer one is wide enough for a thumb; the foot is deepest of all, so the text block seems to rest on the page rather than slide off it.</p>
`;

export const ESSAY_CSS = `body {
  font-family: "Crimson Text";
  font-size: 22px;
  line-height: 32px;
  color: #1b1a19;
}
h1 {
  margin: 180px 0 16px;
  font-size: 56px;
  line-height: 62px;
  font-weight: 600;
  text-align: center;
}
.subtitle {
  font-style: italic;
  text-align: center;
  font-size: 26px;
}
h2 {
  break-before: page;
  margin: 60px 0 36px;
  font-size: 38px;
  line-height: 44px;
  font-weight: 600;
}
p {
  margin: 0 0 12px;
  text-align: justify;
}
blockquote {
  margin: 24px 40px;
  font-style: italic;
}
`;

export const WEBSITE_HTML = `<header class="site-header">
  <a class="brand" href="#">Fieldnote</a>
  <nav aria-label="Site">
    <a href="#features">Features</a>
    <a href="#pricing">Pricing</a>
    <a href="#signup">Sign up</a>
  </nav>
</header>

<section class="hero">
  <h1>Notes that stay where you put them</h1>
  <p>Fieldnote keeps a notebook for every project: pages you can write on, pin, and pass along, and a search that finds a sketch by the words written beside it.</p>
  <button type="button" id="like">Like this page</button>
  <p class="likes" id="likes" role="status">Nobody has liked this page yet.</p>
</section>

<section id="features">
  <h2>What it does</h2>
  <div class="cards">
    <article class="card">
      <h3>Write anywhere</h3>
      <p>Type, sketch or paste. Every page keeps its place in the notebook, and every notebook keeps its place on the shelf.</p>
    </article>
    <article class="card">
      <h3>Find it again</h3>
      <p>Search reads handwriting, captions and the names of the files you dropped in, and shows the page it found, not a list of links.</p>
    </article>
    <article class="card">
      <h3>Share a page</h3>
      <p>Send one page or a whole notebook. People you share with see your changes as you make them.</p>
    </article>
    <article class="card">
      <h3>Work offline</h3>
      <p>Everything lives on your device first. When a connection comes back, the notebooks catch up with each other.</p>
    </article>
  </div>
</section>

<section id="pricing">
  <h2>Pricing</h2>
  <table>
    <thead>
      <tr><th scope="col">Plan</th><th scope="col">Notebooks</th><th scope="col">Price</th></tr>
    </thead>
    <tbody>
      <tr><td>Pocket</td><td>3</td><td>Free</td></tr>
      <tr><td>Desk</td><td>Unlimited</td><td>€4 a month</td></tr>
      <tr><td>Studio</td><td>Unlimited, shared</td><td>€9 a person</td></tr>
    </tbody>
  </table>
</section>

<section id="signup">
  <h2>Sign up</h2>
  <form id="signup-form">
    <label>Name <input name="name" type="text" placeholder="Ada Lovelace"></label>
    <label>Email <input name="email" type="email" placeholder="ada@example.com"></label>
    <label>Plan
      <select name="plan">
        <option>Pocket</option>
        <option selected>Desk</option>
        <option>Studio</option>
      </select>
    </label>
    <label>What will you keep in it? <textarea name="notes" rows="3"></textarea></label>
    <label class="check"><input name="letters" type="checkbox" checked> Send me the monthly letter</label>
    <button type="submit">Create my notebook</button>
    <p class="thanks" id="thanks" role="status"></p>
  </form>
</section>

<details>
  <summary>Can I export my notes?</summary>
  <p>Yes: every notebook exports as a folder of plain pages and pictures, readable without Fieldnote.</p>
</details>

<footer>
  <p>Fieldnote is a sample site, printed by Sandom.</p>
</footer>

<script>
  let likes = 0;
  document.getElementById("like").addEventListener("click", () => {
    likes += 1;
    document.getElementById("likes").textContent = likes === 1 ? "Liked once." : \`Liked \${likes} times.\`;
  });
  const form = document.getElementById("signup-form");
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const name = form.querySelector("[name=name]").value.trim() || "friend";
    const plan = form.querySelector("[name=plan]").value;
    document.getElementById("thanks").textContent = \`Thanks, \${name}. Your \${plan} notebook is ready.\`;
  });
</script>
`;

export const WEBSITE_CSS = `body {
  font-family: "Inter";
  font-size: 15px;
  line-height: 23px;
  color: #20242b;
}
.site-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 0 14px;
  border-bottom: 1px solid #d8dbe0;
}
.brand {
  font-weight: 700;
  font-size: 19px;
  color: #1d4ed8;
  text-decoration: none;
}
nav a {
  margin-left: 14px;
  color: #4b5563;
  text-decoration: none;
}
.hero {
  padding: 28px 0 8px;
}
h1 {
  margin: 0 0 12px;
  font-size: 30px;
  line-height: 36px;
  font-weight: 700;
}
h2 {
  margin: 30px 0 12px;
  font-size: 21px;
  line-height: 28px;
  font-weight: 650;
}
h3 {
  margin: 0 0 6px;
  font-size: 16px;
  font-weight: 650;
}
p {
  margin: 0 0 10px;
}
button {
  font: inherit;
  font-weight: 600;
  padding: 8px 16px;
  color: #fff;
  background: #1d4ed8;
  border: 0;
  border-radius: 6px;
}
.likes, .thanks {
  margin-top: 8px;
  color: #4b5563;
  font-size: 13px;
}
.cards {
  display: grid;
  grid-template-columns: 1fr;
  gap: 12px;
}
.card {
  padding: 14px 16px 6px;
  border: 1px solid #d8dbe0;
  border-radius: 8px;
  background: #f7f8fa;
}
table {
  width: 100%;
  border-collapse: collapse;
}
th, td {
  padding: 7px 8px;
  text-align: left;
  border-bottom: 1px solid #d8dbe0;
}
th {
  font-weight: 600;
  color: #4b5563;
}
form {
  display: grid;
  gap: 10px;
}
label {
  display: grid;
  gap: 4px;
  font-weight: 500;
}
label.check {
  display: flex;
  align-items: center;
  gap: 8px;
}
input, select, textarea {
  font: inherit;
  padding: 6px 8px;
  border: 1px solid #b8bec8;
  border-radius: 5px;
  background: #fff;
}
form button {
  justify-self: start;
}
details {
  margin-top: 24px;
  padding: 10px 12px;
  border: 1px solid #d8dbe0;
  border-radius: 8px;
}
summary {
  font-weight: 600;
}
footer {
  margin-top: 28px;
  padding-top: 12px;
  border-top: 1px solid #d8dbe0;
  color: #6b7280;
  font-size: 13px;
}
/* A wide page, such as the sketchpad's, has room for two columns of cards. */
@media (min-width: 800px) {
  .cards {
    grid-template-columns: 1fr 1fr;
  }
  form {
    grid-template-columns: 1fr 1fr;
  }
  form label:nth-of-type(4), label.check, form button, .thanks {
    grid-column: 1 / -1;
  }
}
`;
