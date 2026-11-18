(()=>{'use strict';
const reduced=window.matchMedia('(prefers-reduced-motion: reduce)').matches;
if(!reduced){
 const canvas=document.createElement('canvas');canvas.className='winter-snow';canvas.setAttribute('aria-hidden','true');document.body.appendChild(canvas);
 const ctx=canvas.getContext('2d',{alpha:true});let w=0,h=0,dpr=1,flakes=[],raf=0,last=0;
 function resize(){dpr=Math.min(window.devicePixelRatio||1,1.5);w=innerWidth;h=innerHeight;canvas.width=Math.round(w*dpr);canvas.height=Math.round(h*dpr);canvas.style.width=w+'px';canvas.style.height=h+'px';ctx.setTransform(dpr,0,0,dpr,0,0);const count=Math.min(150,Math.max(42,Math.round(w*h/9300)));flakes=Array.from({length:count},()=>({x:Math.random()*w,y:Math.random()*h,r:.55+Math.random()*2.15,v:.28+Math.random()*1.05,dr:(Math.random()-.5)*.38,a:.18+Math.random()*.58,phase:Math.random()*6.28,glint:Math.random()>.82}))}
 function draw(t){raf=requestAnimationFrame(draw);if(t-last<30)return;last=t;ctx.clearRect(0,0,w,h);for(const f of flakes){f.y+=f.v;f.x+=f.dr+Math.sin(t*.00045+f.phase)*.2;if(f.y>h+5){f.y=-6;f.x=Math.random()*w}if(f.x>w+6)f.x=-6;if(f.x< -6)f.x=w+6;ctx.beginPath();ctx.arc(f.x,f.y,f.r,0,Math.PI*2);ctx.fillStyle='rgba(231,249,255,'+(f.glint?Math.min(.9,f.a+.2):f.a)+')';ctx.fill()}}
 resize();addEventListener('resize',resize,{passive:true});raf=requestAnimationFrame(draw);
 const targets=document.querySelectorAll('main section,main article,.project-card,.feature,.account-panel');
 if('IntersectionObserver'in window){const io=new IntersectionObserver(entries=>entries.forEach(e=>{if(e.isIntersecting){e.target.classList.add('is-visible');io.unobserve(e.target)}}),{threshold:.08});targets.forEach((el,i)=>{if(i>0){el.classList.add('winter-reveal');io.observe(el)}})}
 document.querySelectorAll('.hero,.home-hero,.hero-section').forEach(hero=>{const orb=document.createElement('span');orb.className='winter-orb';orb.style.cssText='right:-90px;top:8%;';hero.appendChild(orb);const star=document.createElement('span');star.className='winter-ornament';star.textContent='❄';star.style.cssText='right:9%;top:22%;';hero.appendChild(star)});
 addEventListener('pagehide',()=>cancelAnimationFrame(raf),{once:true});
}else{document.querySelectorAll('.winter-reveal').forEach(el=>el.classList.add('is-visible'))}
})();