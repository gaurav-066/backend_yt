const express = require('express');
const cors = require('cors');
const { execFile } = require('child_process');
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());

/* CONFIG */

const MAX_CONCURRENT = 2;
const MAX_VIDEO_DURATION = 420;
const CACHE_TTL = 3 * 60 * 60 * 1000;
const COOKIES_FILE = path.join(__dirname, 'cookies.txt');

/* COOKIE SETUP */

if (process.env.YT_COOKIES) {
  try {
    fs.writeFileSync(COOKIES_FILE, process.env.YT_COOKIES.replace(/\\n/g,"\n"));
    console.log("Cookies loaded");
  } catch (e) {
    console.warn("Cookie write failed:", e.message);
  }
}

/* VERIFY yt-dlp */

execFile("yt-dlp",["--version"],(err,stdout)=>{
  if(err) console.error("yt-dlp not found");
  else console.log("yt-dlp:",stdout.trim());
});

/* CACHE */

const urlCache = new Map();

function cacheUrl(key,url){
  urlCache.set(key,{url,ts:Date.now()});
}

function getCachedUrl(key){
  const e=urlCache.get(key);
  if(!e) return null;
  if(Date.now()-e.ts>CACHE_TTL){
    urlCache.delete(key);
    return null;
  }
  return e.url;
}

/* SAFE JSON PARSER */

function safeParse(raw){
  const i=raw.indexOf("{");
  if(i===-1) throw new Error("Invalid yt-dlp output");
  return JSON.parse(raw.slice(i));
}

/* YT-DLP WRAPPER */

function ytdlp(args){
  return new Promise((resolve,reject)=>{

    const cookieArgs=fs.existsSync(COOKIES_FILE)
      ? ["--cookies",COOKIES_FILE]
      : [];

    const fullArgs=[
      ...cookieArgs,
      "--no-warnings",
      "--no-check-certificates",
      "--no-playlist",
      ...args
    ];

    execFile(
      "yt-dlp",
      fullArgs,
      {timeout:40000,maxBuffer:10*1024*1024},
      (err,stdout,stderr)=>{
        if(err){
          const line=(stderr||err.message).split("\n")[0];
          return reject(new Error(line));
        }
        resolve(stdout.trim());
      }
    );
  });
}

/* CONCURRENCY */

let active=0;

/* /play */

app.get("/play",async(req,res)=>{

const query=req.query.q;
if(!query) return res.status(400).json({error:"Query required"});
if(active>=MAX_CONCURRENT)
return res.status(503).json({error:"Server busy"});

active++;

try{

const raw=await ytdlp([`ytsearch1:${query}`,"-j"]);
const info=safeParse(raw);

const formats=info.formats||[];

let streamUrl=null;

const audio=formats
.filter(f=>f.acodec!=="none"&&(f.vcodec==="none"||!f.vcodec)&&!f.url.includes("manifest"))
.sort((a,b)=>(b.abr||0)-(a.abr||0));

if(audio.length>0) streamUrl=audio[0].url;

if(!streamUrl) streamUrl=info.url;

if(!streamUrl) throw new Error("No audio stream found");

const key=`${info.id}:audio`;
cacheUrl(key,streamUrl);

const host=`https://${req.get("host")}`;

res.json({
videoId:info.id,
title:info.title,
artist:info.channel||info.uploader||"",
duration:info.duration||0,
thumbnail:info.thumbnail,
url:`${host}/stream/${info.id}?t=audio`
});

}catch(e){

res.status(500).json({error:e.message});

}finally{

active--;

}

});

/* /video */

app.get("/video",async(req,res)=>{

const query=req.query.q;
if(!query) return res.status(400).json({error:"Query required"});
if(active>=MAX_CONCURRENT)
return res.status(503).json({error:"Server busy"});

active++;

try{

const raw=await ytdlp([`ytsearch1:${query}`,"-j"]);
const info=safeParse(raw);

if(info.duration && info.duration>MAX_VIDEO_DURATION)
return res.status(204).end();

const formats=info.formats||[];

let streamUrl=null;

const mp4=formats
.filter(f=>f.acodec!=="none"&&f.vcodec!=="none"&&f.ext==="mp4"&&(f.height||0)<=480&&!f.url.includes("manifest"))
.sort((a,b)=>(b.height||0)-(a.height||0));

if(mp4.length>0) streamUrl=mp4[0].url;

if(!streamUrl) streamUrl=info.url;

if(!streamUrl) throw new Error("No video stream found");

const key=`${info.id}:video`;
cacheUrl(key,streamUrl);

const host=`https://${req.get("host")}`;

res.json({
videoId:info.id,
title:info.title,
duration:info.duration,
url:`${host}/stream/${info.id}?t=video`
});

}catch(e){

res.status(500).json({error:e.message});

}finally{

active--;

}

});

/* STREAM PROXY */

app.get("/stream/:id",(req,res)=>{

const id=req.params.id;
const type=req.query.t||"audio";

const source=getCachedUrl(`${id}:${type}`);
if(!source) return res.status(410).json({error:"Stream expired"});

const parsed=new URL(source);
const client=parsed.protocol==="https:"?https:http;

const headers={
"User-Agent":"Mozilla/5.0"
};

if(req.headers.range)
headers.Range=req.headers.range;

const options={
hostname:parsed.hostname,
port:parsed.port||443,
path:parsed.pathname+parsed.search,
headers
};

const upstream=client.get(options,yt=>{

res.status(yt.statusCode);

["content-type","content-length","content-range","accept-ranges"]
.forEach(h=>{
if(yt.headers[h]) res.setHeader(h,yt.headers[h]);
});

res.setHeader("Access-Control-Allow-Origin","*");

yt.pipe(res);

});

upstream.on("error",()=>{
if(!res.headersSent)
res.status(500).json({error:"Stream failed"});
});

});

/* HEALTH */

app.get("/",(req,res)=>{
res.send(`YT backend | cache:${urlCache.size}`);
});

/* START */

const PORT=process.env.PORT||3000;

app.listen(PORT,()=>{
console.log("Backend running on",PORT);
});
