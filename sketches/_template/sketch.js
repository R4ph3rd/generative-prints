// p5.js sketch (global mode). Loaded as an ES module so it can import Tweakpane.
// p5 auto-starts on window load and picks up window.setup / window.draw.
import { Pane } from 'https://cdn.jsdelivr.net/npm/tweakpane@4.0.5/dist/tweakpane.min.js';

const params = {
  seed: 1234,
  randomize() {
    params.seed = Math.floor(Math.random() * 1_000_000);
    pane.refresh();
    render();
  },
  render() { render(); },
};

const pane = new Pane({ title: 'Controls' });
pane.addBinding(params, 'seed', { min: 0, max: 999999, step: 1 }).on('change', render);
pane.addButton({ title: 'Randomize' }).on('click', params.randomize);
pane.addButton({ title: 'Render' }).on('click', params.render);

// Reseed both generators, then draw one frame.
function render() {
  randomSeed(params.seed);
  noiseSeed(params.seed);
  redraw();
}

window.setup = () => {
  createCanvas(800, 800);
  noLoop();
};

window.draw = () => {
  background(12);
  stroke(240);
  for (let i = 0; i < 400; i++) {
    const x = random(width);
    const y = random(height);
    strokeWeight(noise(x * 0.005, y * 0.005) * 4);
    point(x, y);
  }
};
