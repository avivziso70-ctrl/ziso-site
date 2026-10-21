// Assembles one reel: Kling clips + narration + overlays -> 1080x1920 mp4. usage: node build.mjs SPEC.json
import fs from 'fs'; import path from 'path'; import {execFileSync} from 'child_process';
const specPath=process.argv[2]; const spec=JSON.parse(fs.readFileSync(specPath,'utf8'));
const D=path.dirname(path.resolve(specPath)); const work=path.join(D,'work',spec.name); fs.mkdirSync(work,{recursive:true});
const ff=(a)=>execFileSync('ffmpeg',['-y','-v','error','-nostdin',...a],{stdio:'inherit'});
const probe=(f)=>parseFloat(execFileSync('ffprobe',['-v','error','-show_entries','format=duration','-of','csv=p=0',f]).toString());
const W=1080,H=1920,FPS=30,X=0.4,END=1.6;
execFileSync('node',[path.join(D,'render_overlays.mjs'),specPath,work],{stdio:'inherit'});
const vo=path.join(D,'raw',spec.vo); const voDur=probe(vo); const tail=spec.tail??1.2;
const main=voDur+tail; // seconds of picture under narration
const n=spec.clips.length; const per=(main+X*(n-1))/n; // each clip stretched to this length
const clips=spec.clips.map(c=>path.join(D,'raw',c));
const args=[]; clips.forEach(c=>args.push('-i',c)); // 0..n-1
args.push('-i',vo); const A=n; // audio index
const ov=['base','hook','cta',...spec.caps.map((_,i)=>'cap'+i)]; const OI={};
ov.forEach((k,i)=>{OI[k]=A+1+i; args.push('-framerate','10','-loop','1','-t',String(main+1),'-i',path.join(work,k+'.png'))});
let fc='';
clips.forEach((c,i)=>{const d=probe(c); const r=(per/d).toFixed(5);
  fc+=`[${i}:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setpts=${r}*PTS,fps=${FPS},format=yuv420p,trim=0:${per.toFixed(3)},setpts=PTS-STARTPTS[c${i}];`});
let prev='[c0]',off=0;
for(let k=1;k<n;k++){off+=per-X; fc+=`${prev}[c${k}]xfade=transition=fade:duration=${X}:offset=${off.toFixed(3)}[x${k}];`; prev=`[x${k}]`;}
const hookEnd=spec.hookEnd??3.6, ctaStart=main-(spec.ctaLen??4.2);
fc+=`[${OI.base}:v]format=rgba[ob];${prev}[ob]overlay=0:0:format=auto[v0];`;
fc+=`[${OI.hook}:v]format=rgba,fade=in:st=0:d=0.25:alpha=1,fade=out:st=${(hookEnd-0.35).toFixed(2)}:d=0.35:alpha=1[oh];[v0][oh]overlay=0:0:format=auto:enable='between(t,0,${hookEnd})'[v1];`;
fc+=`[${OI.cta}:v]format=rgba,fade=in:st=${ctaStart.toFixed(2)}:d=0.3:alpha=1[oc];[v1][oc]overlay=0:0:format=auto:enable='gte(t,${ctaStart.toFixed(2)})'[v2];`;
let cur='[v2]';
spec.caps.forEach((c,i)=>{const a=c.t0.toFixed(2),b=c.t1.toFixed(2);
  fc+=`[${OI['cap'+i]}:v]format=rgba,fade=in:st=${a}:d=0.12:alpha=1,fade=out:st=${(c.t1-0.12).toFixed(2)}:d=0.12:alpha=1[oc${i}];${cur}[oc${i}]overlay=0:0:format=auto:enable='between(t,${a},${b})'[v${3+i}];`; cur=`[v${3+i}]`;});
fc+=`${cur}trim=0:${main.toFixed(3)},setpts=PTS-STARTPTS[vout];[${A}:a]loudnorm=I=-16:TP=-1.5:LRA=11,apad=whole_dur=${main.toFixed(3)}[aout]`;
const mainMp4=path.join(work,'main.mp4');
ff([...args,'-filter_complex',fc,'-map','[vout]','-map','[aout]','-c:v','libx264','-preset','veryfast','-crf','16','-pix_fmt','yuv420p','-r',String(FPS),'-c:a','aac','-b:a','160k','-ar','44100','-shortest',mainMp4]);
const endMp4=path.join(work,'end.mp4');
ff(['-loop','1','-t',String(END),'-i',path.join(work,'end.png'),'-f','lavfi','-t',String(END),'-i','anullsrc=r=44100:cl=stereo','-vf',`format=yuv420p,fps=${FPS},fade=in:st=0:d=0.3`,'-c:v','libx264','-crf','18','-pix_fmt','yuv420p','-c:a','aac','-b:a','160k','-shortest',endMp4]);
const outMp4=path.join(D,'out',spec.name+'.mp4'); fs.mkdirSync(path.dirname(outMp4),{recursive:true});
ff(['-i',mainMp4,'-i',endMp4,'-filter_complex',`[0:v][1:v]xfade=transition=fade:duration=0.3:offset=${(main-0.3).toFixed(3)}[v];[0:a][1:a]acrossfade=d=0.3[a]`,'-map','[v]','-map','[a]','-c:v','libx264','-preset','fast','-crf','18','-pix_fmt','yuv420p','-movflags','+faststart','-c:a','aac','-b:a','160k',outMp4]);
ff(['-ss','2.5','-i',outMp4,'-frames:v','1','-q:v','3',outMp4.replace(/\.mp4$/,'-cover.jpg')]);
console.log('OK',outMp4,probe(outMp4).toFixed(2)+'s','vo',voDur.toFixed(2));
