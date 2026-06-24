#!/usr/bin/env node
// Standalone test for the EF funnel "loader" — real SVG path, braille rendering.
//   node ef-loader.mjs            loop until Ctrl-C
//   node ef-loader.mjs --once     single pass
//   node ef-loader.mjs --debug    print the braille shape (no anim)

const ORANGE = [0xff, 0x5a, 0x36];

// The orange funnel path straight out of the EF logo SVG.
const PATH =
  'M61.41,0c-8.1,0-15.88,3.67-20.63,10.24-5.98,8.27-6.47,18.74-1.49,27.37l1.45,2.51,6.28,10.89H.39l4.04,6.99c7.86,13.62,22.39,22.01,38.12,22.01h21.44l21.94,38h-37.07l4.04,6.99c7.86,13.62,22.39,22.01,38.12,22.01h11.87l18.09,31.87c4.52,7.82,12.61,12.49,21.64,12.49s17.13-4.67,21.64-12.49l23.73-40.87h-96.76c-9.25,0-18.02-3.69-24.49-10h90.88c22.29,0,42.88-11.89,54.03-31.19l15.48-26.81H42.57c-9.25,0-18.02-3.69-24.48-10h178.06c21.99,0,42.48-11.83,53.47-30.87L266.43,0H61.41Z';

// ---- minimal SVG path parser (M m L l H h V v C c S s Z) -> polyline ----
function parsePath(d) {
  const toks = d.match(/[a-zA-Z]|-?\d*\.?\d+(?:e-?\d+)?/g);
  const pts = [];
  let i = 0;
  const num = () => parseFloat(toks[i++]);
  let cx = 0, cy = 0, sx = 0, sy = 0, px = 0, py = 0, cmd = '';
  const push = (x, y) => pts.push([x, y]);
  const cubic = (x1, y1, x2, y2, x, y) => {
    const steps = 24;
    for (let t = 1; t <= steps; t++) {
      const u = t / steps, m = 1 - u;
      push(m*m*m*cx + 3*m*m*u*x1 + 3*m*u*u*x2 + u*u*u*x,
           m*m*m*cy + 3*m*m*u*y1 + 3*m*u*u*y2 + u*u*u*y);
    }
    px = x2; py = y2; cx = x; cy = y;
  };
  while (i < toks.length) {
    if (/[a-zA-Z]/.test(toks[i])) cmd = toks[i++];
    switch (cmd) {
      case 'M': cx=num(); cy=num(); sx=cx; sy=cy; push(cx,cy); cmd='L'; break;
      case 'm': cx+=num(); cy+=num(); sx=cx; sy=cy; push(cx,cy); cmd='l'; break;
      case 'L': cx=num(); cy=num(); push(cx,cy); break;
      case 'l': cx+=num(); cy+=num(); push(cx,cy); break;
      case 'H': cx=num(); push(cx,cy); break;
      case 'h': cx+=num(); push(cx,cy); break;
      case 'V': cy=num(); push(cx,cy); break;
      case 'v': cy+=num(); push(cx,cy); break;
      case 'C': { const a=num(),b=num(),c2=num(),d2=num(),e=num(),f=num(); cubic(a,b,c2,d2,e,f); break; }
      case 'c': { const a=cx+num(),b=cy+num(),c2=cx+num(),d2=cy+num(),e=cx+num(),f=cy+num(); cubic(a,b,c2,d2,e,f); break; }
      case 'S': { const a=2*cx-px,b=2*cy-py,c2=num(),d2=num(),e=num(),f=num(); cubic(a,b,c2,d2,e,f); break; }
      case 's': { const a=2*cx-px,b=2*cy-py,c2=cx+num(),d2=cy+num(),e=cx+num(),f=cy+num(); cubic(a,b,c2,d2,e,f); break; }
      case 'Z': case 'z': push(sx,sy); cx=sx; cy=sy; break;
      default: i++;
    }
  }
  return pts;
}

// ---- point-in-polygon (even-odd), with 2x2 supersample per dot ----
function makePixels(poly, W, H) {
  let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;
  for (const [x,y] of poly){ if(x<minX)minX=x; if(x>maxX)maxX=x; if(y<minY)minY=y; if(y>maxY)maxY=y; }
  const w=maxX-minX, h=maxY-minY;
  const inside = (px,py) => {
    let c = false;
    for (let k=0,j=poly.length-1; k<poly.length; j=k++){
      const [xi,yi]=poly[k], [xj,yj]=poly[j];
      if (((yi>py)!==(yj>py)) && (px < (xj-xi)*(py-yi)/(yj-yi)+xi)) c=!c;
    }
    return c;
  };
  const grid = Array.from({length:H},()=>new Uint8Array(W));
  for (let y=0;y<H;y++) for (let x=0;x<W;x++){
    let hit=0;
    for (let sy=0;sy<2;sy++) for (let sx=0;sx<2;sx++){
      const px = minX + ((x + (sx+0.5)/2) / W) * w;
      const py = minY + ((y + (sy+0.5)/2) / H) * h;
      if (inside(px,py)) hit++;
    }
    grid[y][x] = hit >= 2 ? 1 : 0; // majority -> on
  }
  return grid;
}

// ---- pack pixel grid into braille cells (2 wide x 4 tall) ----
const DOTS = [[0x01,0x08],[0x02,0x10],[0x04,0x20],[0x40,0x80]]; // [row][col] bit
function toBrailleRows(grid) {
  const H=grid.length, W=grid[0].length;
  const rows=[];
  for (let cy=0; cy<H; cy+=4){
    const cells=[];
    for (let cx=0; cx<W; cx+=2){
      let bits=0;
      for (let dy=0; dy<4; dy++) for (let dx=0; dx<2; dx++){
        if (grid[cy+dy]?.[cx+dx]) bits |= DOTS[dy][dx];
      }
      cells.push(bits);
    }
    rows.push(cells);
  }
  return rows; // rows[r][c] = braille bitmask
}

const COLS = 18;                 // braille cells wide
const W = COLS*2;
const aspect = 191.36/266.43;
const H = Math.round(W*aspect/4)*4;
const poly = parsePath(PATH);
const braille = toBrailleRows(makePixels(poly, W, H));

if (process.argv.includes('--debug')) {
  console.log(braille.map(r => r.map(b => String.fromCharCode(0x2800+b)).join('')).join('\n'));
  process.exit(0);
}

// ---- animated render ----
const fg = ([r,g,b]) => `\x1b[38;2;${r};${g};${b}m`;
const RESET='\x1b[0m', HIDE='\x1b[?25l', SHOW='\x1b[?25h';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const ROWS = braille.length;

function frame(progress) {
  const lines=[];
  for (let r=0;r<ROWS;r++){
    const d = ROWS<=1 ? 0 : r/(ROWS-1);
    // solid orange body; a brighter band sweeps downward as the "loading" pulse
    const boost = Math.max(0, 1 - Math.abs(d - progress)*2.2);
    const t = Math.min(1, 0.78 + 0.22*boost);
    const col = ORANGE.map(v => Math.min(255, Math.round(v*t)));
    let line='';
    for (const b of braille[r]) line += b ? String.fromCharCode(0x2800+b) : ' ';
    lines.push('  ' + fg(col) + line + RESET);
  }
  return lines.join('\n');
}

async function main(){
  const once = process.argv.includes('--once');
  process.stdout.write(HIDE + '\n'.repeat(ROWS+1));
  const done = () => { process.stdout.write(SHOW+'\n'); process.exit(0); };
  process.on('SIGINT', done);
  const dots=['   ','.  ','.. ','...'];
  let s=0;
  try {
    do {
      for (let p=0;p<=24;p++,s++){
        process.stdout.write(`\x1b[${ROWS+1}A\r` + frame(p/24) + '\n' +
          fg(ORANGE) + `  Syncing${dots[Math.floor(s/3)%4]}` + RESET + '\x1b[K\n');
        await sleep(55);
      }
    } while(!once);
  } finally { process.stdout.write(SHOW); }
}
main();
