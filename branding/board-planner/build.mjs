import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const root = path.dirname(fileURLToPath(import.meta.url));
const assets = [];
const colors = { blue: '#3B82F6', action: '#2563EB', navy: '#0F172A', slate: '#1E293B', paper: '#F8FAFC', muted: '#475569', review: '#C084FC', done: '#4ADE80' };
const font = 'Arial, Helvetica, sans-serif';
const esc = s => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
const text = (s,x,y,size,fill,weight=400,extra='') => `<text x="${x}" y="${y}" font-family="${font}" font-size="${size}" font-weight="${weight}" fill="${fill}" ${extra}>${esc(s)}</text>`;
const rect = (x,y,w,h,r,fill,extra='') => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="${fill}" ${extra}/>`;
function mark(x=0,y=0,size=32,mode='color') {
  const bg = mode === 'white' ? '#FFFFFF' : mode === 'navy' ? colors.navy : colors.blue;
  const fg = mode === 'white' ? colors.navy : '#FFFFFF';
  const cards = [[5,6,.9],[5,12,.6],[13,6,.9],[13,12,.6],[13,18,.4],[21,6,.9]];
  return `<g transform="translate(${x} ${y}) scale(${size/32})">${rect(0,0,32,32,8,bg)}${cards.map(([cx,cy,o])=>rect(cx,cy,6,4,1,fg,`opacity="${o}"`)).join('')}</g>`;
}
function svg(w,h,body,title) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img"><title>${esc(title)}</title>${body}</svg>`;
}
async function save(relative,title,category,w,h,body,{png=true,usage='',preview='light'}={}) {
  const file = relative+'.svg';
  await fs.mkdir(path.dirname(path.join(root,file)),{recursive:true});
  const source = svg(w,h,body,title);
  await fs.writeFile(path.join(root,file),source);
  assets.push({file,title,category,width:w,height:h,format:'SVG',usage,preview});
  if(png) {
    await sharp(Buffer.from(source)).png().toFile(path.join(root,relative+'.png'));
    assets.push({file:relative+'.png',title,category,width:w,height:h,format:'PNG',usage,preview});
  }
}

for(const [mode,title] of [['color','Primary mark'],['navy','Navy mark'],['white','Reverse mark']]) {
  await save(`logos/mark-${mode}`,title,'Logos',512,512,mark(0,0,512,mode),{usage:'Avatars, application identity and small placements.',preview:mode==='white'?'dark':'light'});
}
for(const [tone,fill] of [['navy',colors.navy],['white','#FFFFFF']]) {
  await save(`logos/wordmark-${tone}`,`Horizontal logo · ${tone}`,'Logos',760,128,mark(8,16,96)+text('Board Planner',128,86,66,fill,700),{usage:'Website headers, documents and presentations. Transparent background.',preview:tone==='white'?'dark':'light'});
  await save(`logos/stacked-${tone}`,`Stacked logo · ${tone}`,'Logos',560,304,mark(216,24,128)+text('Board Planner',280,245,60,fill,700,'text-anchor="middle"'),{usage:'Centered layouts and compact covers. Transparent background.',preview:tone==='white'?'dark':'light'});
}
for(const size of [16,32,48,64,128,180,192,256,512,1024]) {
  await fs.mkdir(path.join(root,'icons'),{recursive:true});
  const file = `icons/app-${size}.png`;
  await sharp(Buffer.from(svg(size,size,mark(0,0,size),'Board Planner app icon'))).png().toFile(path.join(root,file));
  assets.push({file,title:`App icon · ${size}`,category:'Icons',width:size,height:size,format:'PNG',usage:size===180?'Apple touch icon':size===192||size===512?'Web app manifest icon':'App icons, favicons and avatars.',preview:'light'});
}
// A standard multi-resolution favicon: PNG-compressed ICO entries.
const iconBuffers = await Promise.all([16,32,48].map(s=>fs.readFile(path.join(root,`icons/app-${s}.png`))));
const header = Buffer.alloc(6+16*iconBuffers.length); header.writeUInt16LE(1,2); header.writeUInt16LE(iconBuffers.length,4);
let offset=header.length;
iconBuffers.forEach((buf,i)=>{ const p=6+i*16; header[p]=[16,32,48][i]; header[p+1]=header[p]; header.writeUInt16LE(1,p+4); header.writeUInt16LE(32,p+6); header.writeUInt32LE(buf.length,p+8); header.writeUInt32LE(offset,p+12); offset+=buf.length; });
await fs.writeFile(path.join(root,'icons/favicon.ico'),Buffer.concat([header,...iconBuffers]));
assets.push({file:'icons/favicon.ico',title:'Multi-size favicon',category:'Icons',format:'ICO',usage:'16, 32 and 48 px entries.',preview:'light'});

function board(x,y,w,h,dark=true) {
  const panel=dark?'#1E293B':'#FFFFFF', line=dark?'#334155':'#CBD5E1', ink=dark?'#F8FAFC':'#0F172A';
  let b=rect(x,y,w,h,24,panel,`stroke="${line}" stroke-width="2"`);
  const gap=18, cw=(w-64-gap*2)/3;
  ['Planned','In progress','Done'].forEach((label,c)=>{
    const cx=x+32+c*(cw+gap);
    b+=rect(cx,y+32,8,8,4,[colors.blue,'#FBBF24',colors.done][c]);
    b+=text(label,cx+17,y+42,14,ink,700);
    const count=[2,3,1][c];
    for(let r=0;r<count;r++) {
      const cy=y+68+r*74;
      b+=rect(cx,cy,cw,58,10,dark?'#0F172A':'#F1F5F9');
      b+=rect(cx+12,cy+14,cw*.66,6,3,r===0&&c===1?colors.blue:dark?'#64748B':'#94A3B8');
      b+=rect(cx+12,cy+29,cw*.45,5,2.5,dark?'#334155':'#CBD5E1');
      b+=rect(cx+12,cy+43,23,4,2,[colors.blue,colors.review,colors.done][c]);
    }
  });
  return b;
}
for(const dark of [false,true]) {
  const tone=dark?'dark':'light', bg=dark?colors.navy:colors.paper, fg=dark?colors.paper:colors.navy, muted=dark?'#A9B6C8':colors.muted;
  let body=rect(0,0,1200,630,0,bg)+mark(64,54,52)+text('Board Planner',132,91,30,fg,700);
  body+=text('One board.',64,252,76,fg,700)+text('Your team works it.',64,328,48,fg,700)+text('So do your agents.',64,392,48,colors.blue,700);
  body+=text('Kanban. Sprints. People. Agents.',64,496,22,muted)+text('board-planner.com',64,568,20,muted);
  body+=board(704,158,432,340,dark);
  await save(`social/open-graph-${tone}`,`Open Graph · ${tone}`,'Social',1200,630,body,{usage:'Website link previews and launch announcements.',preview:tone});
  body=rect(0,0,1080,1080,0,bg)+mark(72,70,64)+text('Board Planner',156,116,38,fg,700);
  body+=text('One board.',72,292,104,fg,700)+text('Your team works it.',72,371,56,fg,700)+text('So do your agents.',72,445,56,colors.blue,700);
  body+=board(72,524,936,358,dark)+text('Kanban. Sprints. People. Agents.',72,974,25,muted)+text('board-planner.com',72,1026,22,muted);
  await save(`social/square-${tone}`,`Square post · ${tone}`,'Social',1080,1080,body,{usage:'Square social announcements and community posts.',preview:tone});
  body=rect(0,0,1500,500,0,bg)+mark(68,65,60)+text('Board Planner',148,108,34,fg,700)+text('One board.',68,252,84,fg,700)+text('Your team works it. So do your agents.',68,326,34,fg,700)+text('board-planner.com',68,432,21,muted)+board(1000,72,430,356,dark);
  await save(`banners/header-${tone}`,`Community header · ${tone}`,'Banners',1500,500,body,{usage:'General community and repository headers. Adapt crop for each platform.',preview:tone});
  body=rect(0,0,1600,900,0,bg)+mark(96,80,72)+text('Board Planner',196,133,48,fg,700)+text('One board.',96,432,144,fg,700)+text('Your team works it.',96,545,72,fg,700)+text('So do your agents.',96,638,72,colors.blue,700)+text('board-planner.com',96,804,28,muted)+board(980,302,524,364,dark);
  await save(`banners/presentation-${tone}`,`Presentation cover · ${tone}`,'Banners',1600,900,body,{usage:'16:9 presentation and video title cards.',preview:tone});
  body=rect(0,0,1200,800,0,bg);
  for(let row=0;row<5;row++) for(let col=0;col<7;col++) {
    const x=col*190-40+(row%2)*64,y=row*180-32;
    body+=`<g opacity="${dark?.18:.12}">${mark(x,y,104,col%3===0?'color':'navy')}</g>`;
  }
  await save(`patterns/board-grid-${tone}`,`Board pattern · ${tone}`,'Patterns',1200,800,body,{usage:'Decorative backgrounds. Keep copy on a separate solid area.',preview:tone});
}

const illustrationInfo=await sharp(path.join(root,'illustrations/shared-board.png')).metadata();
assets.push({file:'illustrations/shared-board.png',title:'Shared board illustration',category:'Illustration',width:illustrationInfo.width,height:illustrationInfo.height,format:'PNG',usage:'Hero artwork and editorial campaign illustration. AI-generated, conceptual artwork.',preview:'light'});
await fs.writeFile(path.join(root,'tokens.json'),JSON.stringify({name:'Board Planner',colors,fontFamily:font,tagline:'One board. Your team works it. So do your agents.'},null,2)+'\n');
await fs.writeFile(path.join(root,'tokens.css'),`:root {\n${Object.entries(colors).map(([key,value])=>`  --bp-${key}: ${value};`).join('\n')}\n  --bp-font: ${font};\n}\n`);
await fs.writeFile(path.join(root,'manifest.json'),JSON.stringify(assets,null,2)+'\n');

const previews=assets.filter(a=>a.format==='SVG'||a.category==='Illustration'||(a.category==='Icons'&&[32,180,512,1024].includes(a.width)));
const categories=['All','Logos','Icons','Social','Banners','Patterns','Illustration'];
function card(a) {
  const companion=assets.find(b=>b.file.replace(/\.[^.]+$/,'')===a.file.replace(/\.[^.]+$/,'')&&b.format!==a.format);
  return `<article class="asset" data-category="${a.category}"><div class="preview ${a.preview} ${a.category==='Icons'?'icon-preview':''}"><img src="${a.file}" alt="${esc(a.title)}" loading="lazy"></div><div class="info"><div class="asset-head"><h3>${esc(a.title)}</h3><span>${a.width} × ${a.height}</span></div><p>${esc(a.usage)}</p><div class="downloads"><a download href="${a.file}">↓ ${a.format}</a>${companion?`<a download href="${companion.file}">↓ ${companion.format}</a>`:''}</div></div></article>`;
}
const html=`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Board Planner · Brand catalog</title><style>
*{box-sizing:border-box}body{margin:0;background:#F8FAFC;color:#0F172A;font:16px Arial,Helvetica,sans-serif}a{color:inherit}header{padding:25px 6%;display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid #DDE3EC}.identity{display:flex;align-items:center;gap:12px;font-size:19px;font-weight:700}.identity img{width:32px}.edition{font:12px monospace;color:#475569}main{max-width:1500px;margin:auto;padding:0 6% 80px}.intro{padding:66px 0 45px;display:grid;grid-template-columns:1.6fr 1fr;gap:64px;align-items:end}.eyebrow{font:12px monospace;text-transform:uppercase;letter-spacing:2px;color:#2563EB}h1{font-size:clamp(48px,6vw,84px);letter-spacing:-4px;line-height:1.04;margin:18px 0 22px}h1 span{color:#2563EB}.intro p{max-width:650px;font-size:19px;line-height:1.65;color:#475569}.package{border-left:1px solid #CBD5E1;padding:8px 0 8px 32px}.package p{font-size:15px;margin:0 0 22px}.button{display:inline-block;padding:13px 20px;background:#2563EB;color:white;border-radius:8px;text-decoration:none;font-weight:700;font-size:14px}.secondary{display:inline-block;margin-left:15px;color:#475569;font-size:14px}.hero{position:relative;overflow:hidden;border-radius:18px;background:#E2E8F0;aspect-ratio:2.3}.hero img{width:100%;height:100%;object-fit:cover;object-position:center 48%}.hero-caption{position:absolute;bottom:22px;left:26px;background:#F8FAFCED;border:1px solid #FFF;padding:10px 15px;border-radius:6px;font:12px monospace;color:#334155}.foundations{padding:54px 0;display:grid;grid-template-columns:1.2fr 1fr;gap:58px;border-bottom:1px solid #CBD5E1}h2{font-size:26px;letter-spacing:-.6px;margin:0 0 10px}.small{font-size:14px;line-height:1.65;color:#475569}.palette{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-top:20px}.swatch{height:56px;border-radius:7px;border:1px solid #D7DEE8}.color strong{display:block;font-size:12px;margin-top:9px}.color code{font-size:11px;color:#475569}.type-sample{font-size:42px;letter-spacing:-1px;margin:18px 0 10px}.guidance{display:flex;gap:16px;flex-wrap:wrap;margin-top:20px;font-size:13px;color:#2563EB}.catalog-header{display:flex;justify-content:space-between;align-items:end;padding:48px 0 22px}.catalog-header p{margin:8px 0 0}.filters{display:flex;flex-wrap:wrap;gap:7px;margin:0 0 25px}.filters button{cursor:pointer;padding:9px 16px;border:1px solid #CBD5E1;border-radius:30px;background:transparent;color:#475569;font:13px Arial}.filters button[aria-pressed=true]{color:#FFF;background:#0F172A;border-color:#0F172A}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:22px}.asset{background:#FFF;border:1px solid #DDE3EC;border-radius:12px;overflow:hidden}.asset[hidden]{display:none}.preview{height:265px;display:flex;align-items:center;justify-content:center;padding:30px;background:repeating-conic-gradient(#F1F5F9 0 25%,#FFF 0 50%) 0/20px 20px}.preview.dark{background:#0F172A}.preview img{max-width:100%;max-height:100%;object-fit:contain}.icon-preview img{width:90px;height:90px;image-rendering:auto}.info{padding:20px}.asset-head{display:flex;justify-content:space-between;gap:12px;align-items:start}h3{font-size:16px;margin:0}.asset-head span{font:11px monospace;color:#64748B;white-space:nowrap}.info p{font-size:13px;line-height:1.55;color:#475569;min-height:40px;margin:12px 0}.downloads{display:flex;gap:10px}.downloads a{border:1px solid #DDE3EC;padding:7px 13px;border-radius:6px;text-decoration:none;color:#2563EB;font-size:12px;font-weight:700}.note{margin-top:28px;font-size:13px;color:#475569}.note a{color:#2563EB}footer{margin-top:55px;padding-top:22px;border-top:1px solid #CBD5E1;font:12px monospace;color:#64748B;display:flex;justify-content:space-between}button:focus-visible,a:focus-visible{outline:3px solid #3B82F6;outline-offset:3px}@media(max-width:750px){header{padding:20px 6%}.edition{display:none}.intro{grid-template-columns:1fr;gap:15px;padding-top:38px}h1{letter-spacing:-2px}.package{border:0;padding:0}.foundations{grid-template-columns:1fr;gap:36px}.grid{grid-template-columns:1fr}.preview{height:230px}.hero{aspect-ratio:1.5}.hero-caption{left:10px;bottom:10px;font-size:10px}.catalog-header{display:block}.asset-head{display:block}.asset-head span{display:block;margin-top:8px}.type-sample{font-size:36px}footer{gap:15px;flex-direction:column}}@media(prefers-reduced-motion:no-preference){.downloads a:hover,.button:hover{filter:brightness(.92)}}
</style></head><body><header><div class="identity"><img src="logos/mark-color.svg" alt="">Board Planner</div><span class="edition">BRAND CATALOG / 01 / OCTOBER 2026</span></header><main><section class="intro"><div><div class="eyebrow">Identity & communication assets</div><h1>One board.<br><span>A shared identity.</span></h1><p>A practical brand kit for the workspace where your team and your agents move work forward together.</p></div><div class="package"><p>${assets.length} assets. Editable vectors, transparent logos, ready-to-use PNGs, and a campaign illustration. Everything in one catalog.</p><a class="button" href="board-planner-brand-kit.zip" download>↓ Download the full kit</a><a class="secondary" href="brand-guide.md">Brand guide ↗</a></div></section><div class="hero"><img src="illustrations/shared-board.png" alt="Tactile navy Kanban columns with blue, violet and green cards connected in a workflow"><span class="hero-caption">01 / SHARED WORK, VISIBLE PROGRESS</span></div><section class="foundations"><div><div class="eyebrow">01 / Color</div><h2 style="margin-top:12px">Blue leads. Status adds meaning.</h2><p class="small">The palette comes from the product. Cobalt identifies the brand; navy anchors it. Violet and green remain supporting accents.</p><div class="palette">${Object.entries(colors).map(([key,value])=>`<div class="color"><div class="swatch" style="background:${value}"></div><strong>${key[0].toUpperCase()+key.slice(1)}</strong><code>${value}</code></div>`).join('')}</div></div><div><div class="eyebrow">02 / Type & voice</div><h2 style="margin-top:12px">Clear enough to get to work.</h2><div class="type-sample">Board Planner<br><b>People. Agents. Progress.</b></div><p class="small">Arial / Helvetica / system sans-serif. Bold headlines, direct sentences, specific claims. Use the existing line: “One board. Your team works it. So do your agents.”</p><div class="guidance"><a download href="tokens.json">Color tokens · JSON</a><a download href="tokens.css">Color tokens · CSS</a><a href="brand-guide.md">Usage & copy guide</a></div></div></section><section><div class="catalog-header"><div><div class="eyebrow">03 / The assets</div><h2 style="margin-top:12px">Ready for the places you show up.</h2><p class="small">Choose a category, preview an asset, and download the format you need.</p></div><span id="count" class="edition">${previews.length} previews / ${assets.length} files</span></div><nav class="filters" aria-label="Filter assets">${categories.map(c=>`<button type="button" data-filter="${c}" aria-pressed="${c==='All'}">${c}</button>`).join('')}</nav><div class="grid">${previews.map(card).join('')}</div><p class="note">All ten app icon sizes and the multi-size <a download href="icons/favicon.ico">favicon</a> are included in the full kit. <a href="manifest.json">View the complete file manifest.</a></p></section><footer><span>BOARD PLANNER · board-planner.com</span><span>Brand kit v1 · Based on the existing product identity.</span></footer></main><script>const buttons=[...document.querySelectorAll('[data-filter]')];const cards=[...document.querySelectorAll('.asset')];buttons.forEach(button=>button.addEventListener('click',()=>{buttons.forEach(b=>b.setAttribute('aria-pressed',String(b===button)));let count=0;cards.forEach(card=>{card.hidden=button.dataset.filter!=='All'&&card.dataset.category!==button.dataset.filter;if(!card.hidden)count++;});document.getElementById('count').textContent=count+' previews';}));</script></body></html>`;
await fs.writeFile(path.join(root,'index.html'),html);
console.log(`Created ${assets.length} assets and ${previews.length} catalog previews at ${root}`);
