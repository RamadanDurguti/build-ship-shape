/**
 * Three real jobs, written down properly.
 *
 * These are the procedures the system ships with. They are ordinary domestic
 * work, and the numbers are the ones a competent tradesperson would give you:
 * recoat times off the tin, filler going off, adhesive grabbing, grout curing,
 * dough proving.
 *
 * They are deliberately not all decorating. The engine does not know what
 * paint is — it knows work, dwell and dependency — and a bread recipe
 * schedules through it unchanged. That is the point of separating the two.
 */
import { material, procedure, step } from './model.js';

export const PAINT_A_ROOM = procedure({
  id: 'paint-a-room',
  title: 'Paint a room',
  summary: 'Walls and ceiling, two coats each, on a room that has been lived in.',
  beforeYouStart: [
    'Take the curtains down and the plug covers off before anything else.',
    'Open a window. Everything on this list dries faster with air moving.',
  ],
  steps: [
    step('clear', 'Clear the room and put sheets down', {
      workMin: 45, uses: ['room'],
      say: 'Furniture to the middle, sheets down, sockets off.' }),
    step('fill', 'Fill the holes and cracks', {
      workMin: 25, dwellMin: 120, weatherSensitive: true, needs: ['clear'],
      say: 'Fill everything, even the ones you think you will not notice.' }),
    step('sand', 'Sand the filler back and key the walls', {
      workMin: 35, needs: ['fill'], uses: ['sander'],
      say: 'Sand the filler flush, then a light pass over the whole wall.' }),
    step('wash', 'Wash the walls down', {
      workMin: 30, dwellMin: 90, weatherSensitive: true, needs: ['sand'],
      say: 'Sugar soap, then clean water. Paint will not stick to dust.' }),
    step('mask', 'Mask the edges', {
      workMin: 30, needs: ['wash'],
      say: 'Tape the skirting, the frames and the switches.' }),
    step('ceiling_cut', 'Cut in the ceiling', {
      workMin: 25, needs: ['mask'], uses: ['brush'],
      say: 'Brush a band round the edge of the ceiling before you roll it.' }),
    step('ceiling_1', 'Ceiling, first coat', {
      workMin: 30, dwellMin: 240, weatherSensitive: true, needs: ['ceiling_cut'], uses: ['roller'],
      say: 'Roll the ceiling. Keep a wet edge and do not stop halfway.' }),
    step('ceiling_2', 'Ceiling, second coat', {
      workMin: 30, dwellMin: 240, weatherSensitive: true, needs: ['ceiling_1'], uses: ['roller'],
      optional: true, importance: 3,
      costOfSkipping: 'One coat on the ceiling will look patchy where the old colour shows through.',
      say: 'Second coat on the ceiling.' }),
    step('walls_cut', 'Cut in the walls', {
      workMin: 35, needs: ['ceiling_1'], uses: ['brush'],
      say: 'Brush the corners, the ceiling line and round the frames.' }),
    step('walls_1', 'Walls, first coat', {
      workMin: 45, dwellMin: 240, weatherSensitive: true, needs: ['walls_cut'], uses: ['roller'],
      say: 'First coat on the walls. Wall at a time, top to bottom.' }),
    step('walls_2', 'Walls, second coat', {
      workMin: 45, dwellMin: 240, weatherSensitive: true, needs: ['walls_1'], uses: ['roller'],
      say: 'Second coat. This is the one people see.' }),
    step('woodwork', 'Gloss the skirting and frames', {
      workMin: 60, dwellMin: 360, weatherSensitive: true, needs: ['walls_1'], uses: ['brush'],
      optional: true, importance: 1,
      costOfSkipping: 'The old skirting will sit against fresh walls and show its age.',
      say: 'Skirting and frames. Thin coat, do not overwork it.' }),
    // Tape comes off while the last coat is still soft — waiting for it to
    // cure is how you tear the paint off with the tape.
    step('unmask', 'Pull the tape and put the room back', {
      workMin: 40, follows: ['walls_2'], uses: ['room'],
      say: 'Pull the tape while the last coat is still slightly soft.' }),
  ],
  materials: [
    material('Wall emulsion', 'litres', { per: 12, soldIn: 2.5, coats: 2,
      note: 'About 12 square metres per litre per coat on sound plaster.' }),
    material('Ceiling paint', 'litres', { per: 13, soldIn: 2.5, coats: 2,
      note: 'Ceilings take a little less than walls.' }),
    material('Filler', 'tubs', { per: 25, soldIn: 1 }),
    material('Masking tape', 'rolls', { per: 18, soldIn: 1,
      note: 'Roughly one roll per eighteen square metres of wall.' }),
  ],
});

export const TILE_A_SPLASHBACK = procedure({
  id: 'tile-a-splashback',
  title: 'Tile and grout a splashback',
  summary: 'A small run of wall tiles behind a worktop, done properly, including the cure.',
  beforeYouStart: [
    'Turn the water off at the isolators before you take the old one off.',
    'The worktop is out of action from the moment you start until the grout has cured.',
  ],
  steps: [
    step('strip', 'Strip the old splashback and clear the worktop', {
      workMin: 40, uses: ['worktop'],
      say: 'Old tiles off, old sealant off, worktop clear.' }),
    step('prep', 'Make the wall flat and clean', {
      workMin: 35, dwellMin: 60, weatherSensitive: true, needs: ['strip'],
      say: 'Fill the gouges and let it go off before you tile over it.' }),
    step('setout', 'Set out and mark the first row', {
      workMin: 25, needs: ['prep'],
      say: 'Find the centre and work out. Never start from a corner.' }),
    step('tile', 'Fix the tiles', {
      workMin: 90, dwellMin: 1440, needs: ['setout'], uses: ['worktop', 'trowel'],
      holdsWhileDwelling: ['worktop'],
      say: 'Tiles on. Once they are on, nobody touches the worktop until tomorrow.' }),
    step('grout', 'Grout', {
      workMin: 45, dwellMin: 1440, needs: ['tile'], uses: ['worktop'],
      holdsWhileDwelling: ['worktop'],
      say: 'Grout in, diagonal strokes, wipe back before it hardens.' }),
    step('polish', 'Polish the haze off', {
      workMin: 20, follows: ['grout'],
      say: 'Dry cloth, take the film off the face of the tiles.' }),
    step('seal', 'Run the silicone bead', {
      workMin: 30, dwellMin: 720, needs: ['polish'], uses: ['worktop'],
      holdsWhileDwelling: ['worktop'], optional: true, importance: 2,
      costOfSkipping: 'Without the bead, water gets behind the bottom row and lifts it.',
      say: 'One continuous bead along the worktop join.' }),
  ],
  materials: [
    material('Wall tiles', 'boxes', { per: 1, soldIn: 1,
      note: 'One box per square metre, plus one for cuts and breakages.' }),
    material('Tile adhesive', 'kg', { per: 0.6, soldIn: 5,
      note: 'Roughly one and a half kilos per square metre at 3mm.' }),
    material('Grout', 'kg', { per: 2, soldIn: 2.5 }),
  ],
});

export const SOURDOUGH = procedure({
  id: 'sourdough',
  title: 'Bake a sourdough loaf',
  summary: 'Not a home improvement. Here to show the engine does not care what the job is.',
  beforeYouStart: [
    'Feed the starter the night before. Everything after this assumes it is lively.',
  ],
  steps: [
    step('autolyse', 'Mix flour and water and leave it', {
      workMin: 10, dwellMin: 60, uses: ['bowl'],
      say: 'Flour and water only. No salt, no starter yet.' }),
    step('mix', 'Add the starter and salt', {
      workMin: 10, dwellMin: 30, needs: ['autolyse'], uses: ['bowl'],
      say: 'Work the starter and salt through.' }),
    step('folds', 'Four sets of stretch and folds', {
      workMin: 40, dwellMin: 120, needs: ['mix'], uses: ['bowl'],
      say: 'A set every half hour. Then leave it alone to finish rising.' }),
    step('shape', 'Shape and put it in the banneton', {
      workMin: 15, needs: ['folds'],
      say: 'Pre-shape, rest, then shape properly and into the basket.' }),
    step('cold_proof', 'Cold proof in the fridge', {
      workMin: 5, dwellMin: 720, needs: ['shape'], uses: ['fridge'],
      holdsWhileDwelling: ['fridge_shelf'],
      say: 'Into the fridge overnight. This is where the flavour happens.' }),
    step('preheat', 'Heat the oven and the pot', {
      workMin: 5, dwellMin: 45, needs: ['cold_proof'], uses: ['oven'],
      holdsWhileDwelling: ['oven'],
      say: 'Oven as hot as it goes, with the pot inside.' }),
    step('bake', 'Bake', {
      workMin: 10, dwellMin: 45, needs: ['preheat'], uses: ['oven'],
      holdsWhileDwelling: ['oven'],
      say: 'Score it and in it goes. Lid on for the first twenty five minutes.' }),
    step('cool', 'Cool on a rack', {
      workMin: 5, dwellMin: 90, follows: ['bake'],
      say: 'Do not cut it hot. It is still cooking.' }),
  ],
});

export const ALL = [PAINT_A_ROOM, TILE_A_SPLASHBACK, SOURDOUGH];
export const get = (id) => ALL.find((p) => p.id === id) ?? null;
