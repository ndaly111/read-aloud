// Read-only audit harness: executes the actual reader functions in an isolated
// JS context with delayed network/audio adapters. No production traffic.
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const assert = require('assert/strict');
const source = fs.readFileSync(path.join(__dirname, '..', 'readaloud.js'), 'utf8');
const styles = fs.readFileSync(path.join(__dirname, '..', 'styles.css'), 'utf8');
function section(from, to) { return source.slice(source.indexOf(from), source.indexOf(to, source.indexOf(from))); }
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}
function context() {
  const nodes = {};
  const ctx = {
    console: {log(){}, warn(){}, error(){}}, Blob, Date, Math, Uint8Array,
    timers:[], setTimeout(fn){ctx.timers.push(fn);return ctx.timers.length;}, clearTimeout(){}, requestAnimationFrame(){},
    txt: {value:'Original passage.'}, rateSlider:{value:'1'}, volSlider:{value:'1'},
    isSpeaking:false, isPaused:false, currentAudio:null, sharedAudio:null,
    timed:null, timedCache:null, lastRead:null, preparedDownload:null,
    loopOn:false, loopGapSec:0, loopGapActive:false,
    mp3Export:null, subtitleExport:null, preferredVoices:new Map(), browserSession:0,
    downloadBlobs:[], progChar:0, totalChars:0,
    playbackElapsedMs:0, playbackStartedAt:null, estimateStartChar:0, estimateStartSeconds:0,
    chunkStartSeconds:0, currentChunkStart:0,
    audioResolve:null, boundarySeen:false, lastPosSaveAt:0, progressLooping:false,
    SEGMENT_CHARS:1200, POSITION_LS_PREFIX:'ra_pos_',
    status:'', error:'', played:[], saved:[], fetches:[], downloads:[], rates:[],
    $:id => nodes[id] || (nodes[id]={disabled:false}),
    setStatus(s){ctx.status=s;}, showError(s){ctx.error=s;},
    updateControls(){}, setupMediaSession(){}, setMediaPlaybackState(){},
    startProgressLoop(){}, stopKeepAlive(){}, stopSilentKeepAlive(){},
    savePosition(k,v){ctx.saved.push({k,v});}, loadPosition(){return 0;}, clearPosition(){},
    hashText:s => s, segmentTextWithOffsets:s=>[{text:s,start:0,end:s.length}],
    updateMeter(v){ctx.meter=v;},
    segIndexForChar(){return 0;}, wordTimeForChar(){return 0;},
    finish(){ctx.isSpeaking=false;ctx.timed=null;},
    URL:{createObjectURL(){return 'blob:test';},revokeObjectURL(){}},
    document:{createElement(){return {click(){ctx.downloads.push(this.download);}};}},
    fetchTimedSegment(seg,voice){const d=deferred();ctx.fetches.push({seg,voice,...d});return d.promise;},
    playTimedSegment(seg){ctx.played.push({text:seg.text,paused:ctx.isPaused,voice:ctx.timed.voiceId}); return new Promise(()=>{});},
  };
  vm.createContext(ctx);
  vm.runInContext(section('function playbackSeconds()', '/* ========== INIT'),ctx);
  vm.runInContext(section('async function useTimedNeuralSpeech(', '// Play one fetched segment'),ctx);
  vm.runInContext(section('async function downloadMp3()', '/* ========== SUBTITLE EXPORT'),ctx);
  vm.runInContext(section('function progressLoop()', 'function buildDisplay()'),ctx);
  vm.runInContext(section('function populateVoiceSel()', 'function updateVoiceStatus()'),ctx);
  vm.runInContext(section('function ensureTimedSegment(', '// Split `seg`'),ctx);
  vm.runInContext(section('function updateExportControls()', 'function finish()'),ctx);
  vm.runInContext(section('async function downloadSubtitles()', 'function resetMeter()'),ctx);
  return ctx;
}
let failures=0;
function result(name,evidence){
  const pass=evidence.pass ?? !evidence.bug;
  if(!pass) failures++;
  console.log(JSON.stringify({name,pass,...evidence}));
}
(async()=>{
  let c=context();
  c.useTimedNeuralSpeech('Sonia'); c.isPaused=true;
  c.fetches[0].seg.blob=new Blob(['audio']);c.fetches[0].resolve();await tick();
  result('Pause during loading',{bug:c.played.some(p=>p.paused),played:c.played});
  assert.equal(c.played.length,0);
  c.isPaused=false;c.timers.shift()();await tick();
  result('Resume after loading',{pass:c.played.length===1&&!c.played[0].paused});

  c=context(); c.useTimedNeuralSpeech('Sonia');
  c.isSpeaking=false;c.timed=null; // Stop, followed by a new Start.
  c.txt.value='New passage.';c.useTimedNeuralSpeech('Guy');
  c.fetches[0].seg.blob=new Blob(['old audio']);c.fetches[0].resolve();await tick();
  result('Late response after Stop and new Start',{bug:c.played.some(p=>p.text==='Original passage.'),played:c.played});
  c.fetches[1].seg.blob=new Blob(['new audio']);c.fetches[1].resolve();await tick();
  result('New reading still plays',{pass:c.played.length===1&&c.played[0].text==='New passage.'});

  c=context();c.useTimedNeuralSpeech('Sonia');c.isSpeaking=false;c.timed=null;
  c.txt.value='New passage.';c.useTimedNeuralSpeech('Guy');
  c.fetches[0].reject(new Error('old request failed'));await tick();
  result('Old failure cancels new reading',{bug:!c.isSpeaking,newSession:c.timed,status:c.status});

  c=context();c.isSpeaking=true;c.timed={curSeg:null};c.totalChars=1000;
  c.progressLoop();
  result('Progress while still loading',{bug:c.progChar>0,unspokenCharsMarkedRead:c.progChar});

  c=context();c.lastRead={key:'old',voiceId:'Sonia',segments:[{text:'Old export',start:0,end:10}]};
  const exportTask=c.downloadMp3();
  c.lastRead=null;c.preparedDownload=null;c.$('download').disabled=true;
  c.fetches[0].seg.blob=new Blob(['old audio']);c.fetches[0].resolve();await exportTask;
  result('Text edited while MP3 is preparing',{bug:c.downloads.length>0,downloaded:c.downloads,buttonReenabled:!c.$('download').disabled});

  c=context();c.rateSlider.value='0.8';
  c.lastRead={key:'same',voiceId:'Sonia',segments:[{text:'Part one'},{text:'Part two'}]};
  const first=deferred();
  c.fetchChunkWithRetry=async(text,voice,index,rate)=>{c.rates.push(rate);if(c.rates.length===1)await first.promise;return new Blob(['audio']);};
  const rateTask=c.downloadMp3();c.rateSlider.value='1.5';first.resolve();await rateTask;
  result('Speed changed during MP3 preparation',{bug:new Set(c.rates).size>1,rates:c.rates,filename:c.downloads[0]});

  c=context();
  c.langSel={value:'en'};c.voiceSel={value:'browser:-1',options:[],appendChild(group){this.options.push(...group.children);}};
  c.document={createElement(){return {children:[],appendChild(child){this.children.push(child);}};}};
  c.browserVoices=[];c.NEURAL_VOICES={en:[{id:'Aria',name:'Aria',gender:'Female'}]};
  c.apiAvailable=true;c.updateVoiceStatus=()=>{};c.populateVoiceSel();
  result('Premium service recovers after automatic browser fallback',{bug:c.voiceSel.value==='browser:-1',selected:c.voiceSel.value});
  c.preferredVoices.set('en','browser:-1');c.populateVoiceSel();
  result('Explicit offline selection survives recovery',{pass:c.voiceSel.value==='browser:-1'});

  c=context();c.txt.value='A long reading. '.repeat(100);c.loadPosition=()=>100;
  c.useTimedNeuralSpeech('Sonia');
  result('Saved positions in the first 200 characters',{bug:c.timed.seekChar===null,saved:100,resumeTarget:c.timed.seekChar});
  c=context();c.txt.value='A long reading. '.repeat(100);c.loadPosition=()=>c.txt.value.length-10;
  c.useTimedNeuralSpeech('Sonia');
  result('Resume near the end',{pass:c.timed.seekChar===c.txt.value.length-10});

  c=context();c.lastRead={key:'old',voiceId:'Sonia',segments:[{text:'Old',start:0,end:3}]};
  const subtitleTask=c.downloadSubtitles();c.lastRead=null;
  c.fetches[0].seg.blob=new Blob(['old']);c.fetches[0].seg.words=[[0,0]];c.fetches[0].resolve();await subtitleTask;
  result('Invalidated subtitle export',{pass:c.downloads.length===0&&c.$('subtitles').disabled});

  c=context();c.lastRead={key:'old',voiceId:'Sonia',segments:[{text:'Old',start:0,end:3,blob:new Blob(['old']),words:[[0,0]]}]};
  const duration=deferred();c.blobDuration=()=>duration.promise;
  const subtitleMetadataTask=c.downloadSubtitles();c.lastRead=null;duration.resolve(1);await subtitleMetadataTask;
  result('Subtitle invalidation while reading audio metadata',{pass:c.downloads.length===0&&c.$('subtitles').disabled});

  c=context();c.isSpeaking=true;c.isPaused=true;c.progChar=10;
  c.progressLoop();result('Paused progress is frozen',{pass:c.progChar===10});

  c=context();c.queue=['Device speech'];c.currentVoiceIndex='-1';c.browserVoices=[];
  c.SpeechSynthesisUtterance=function(text){this.text=text;};
  c.speechSynthesis={speak(){},cancel(){}};c.resetMeter=()=>{};
  c.rateChangeTimer=null;c.volChangeTimer=null;c.utter=null;
  vm.runInContext(section('function stopAll()', '// A saved MP3/subtitle'),c);
  vm.runInContext(section('function speakNextChunk(', '/* ========== PROGRESS'),c);
  c.isSpeaking=true;c.speakNextChunk('-1');const oldError=c.utter.onerror;
  c.utter.onerror({error:'interrupted'});
  result('Device speech failure exits Playing',{pass:!c.isSpeaking&&/Press Start/.test(c.error)});
  c.isSpeaking=true;c.status='New reading';oldError({error:'interrupted'});
  result('Old device speech error cannot stop new reading',{pass:c.isSpeaking&&c.status==='New reading'});

  c=context();c.isSpeaking=true;c.isPaused=true;c.timed={};
  const resumeResult=deferred();c.currentAudio={play:()=>resumeResult.promise};
  vm.runInContext(section('function resumeSpeak()', 'function stopAll()'),c);
  c.resumeSpeak();c.currentAudio={};c.timed={};c.status='New session';
  resumeResult.reject(new Error('old resume failed'));await tick();
  result('Late Resume error cannot pause new reading',{pass:!c.isPaused&&c.status==='New session'});

  c=context();let now=0;let watchdog;let resolved=false;let rejected=false;
  c.Date={now:()=>now};c.setInterval=fn=>{watchdog=fn;return 1;};c.clearInterval=()=>{};
  c.detachChunkHandlers=()=>{};c.timed={curSeg:null};c.isSpeaking=true;
  c.sharedAudio={currentTime:0,paused:false,ended:false,pause(){this.paused=true;},play(){this.paused=false;return Promise.resolve();}};
  vm.runInContext(section('function playTimedSegment(', '/* ========== NEURAL TTS'),c);
  const stalledPlayback=c.playTimedSegment({blob:new Blob(['audio'])},0).then(()=>{resolved=true;},()=>{rejected=true;});
  c.isPaused=true;now=60000;watchdog();await tick();
  result('User Pause never trips stall watchdog',{pass:!resolved&&!rejected});
  c.isPaused=false;watchdog();now+=46000;watchdog();await stalledPlayback;
  result('Stall fails without skipping unspoken text',{pass:rejected&&!resolved});

  // Drive the real media callbacks with a deterministic clock. Waiting,
  // user pauses, and between-segment synthesis must not count as listening.
  c=context();now=0;c.Date={now:()=>now};
  c.setInterval=()=>1;c.clearInterval=()=>{};c.detachChunkHandlers=()=>{};
  c.timed={curSeg:null};c.isSpeaking=true;c.totalChars=1000;
  c.progressBar={};c.meterPercent={};c.elapsedLabel={};c.remainingLabel={};c.highlight=()=>{};
  c.sharedAudio={currentTime:0,paused:true,ended:false,pause(){this.paused=true;},play(){return Promise.resolve();}};
  vm.runInContext(section('function playTimedSegment(', '/* ========== NEURAL TTS'),c);
  vm.runInContext(section('function updateMeter(', 'let lastHlEl'),c);
  vm.runInContext(section('function formatTime(', '/* ========== PAUSE'),c);
  c.resetPlaybackClock();const clip=c.playTimedSegment({blob:new Blob(['audio'])},0);
  now=30000;c.updateMeter(0);
  result('Loading does not advance elapsed time',{pass:c.elapsedLabel.textContent==='00:00:00'});
  c.currentAudio.onplaying();now+=5000;c.updateMeter(250);
  result('Active playback drives elapsed and estimate',{pass:c.elapsedLabel.textContent==='00:00:05'&&c.remainingLabel.textContent==='00:00:15'});
  c.currentAudio.onwaiting();now+=60000;c.updateMeter(250);
  result('Buffering freezes both timers',{pass:c.elapsedLabel.textContent==='00:00:05'&&c.remainingLabel.textContent==='00:00:15'});
  c.currentAudio.onplaying();now+=5000;c.isPaused=true;c.currentAudio.onpause();now+=120000;c.updateMeter(500);
  result('User pause excludes two minutes',{pass:c.elapsedLabel.textContent==='00:00:10'&&c.remainingLabel.textContent==='00:00:10'});
  c.currentAudio.onplaying();now+=1000;
  result('Late playing event cannot restart paused clock',{pass:c.playbackSeconds()===10});
  c.isPaused=false;c.currentAudio.onplaying();now+=5000;c.currentAudio.onended();await clip;
  now+=30000;c.updateMeter(750);
  result('Inter-segment loading preserves accumulated time',{pass:c.elapsedLabel.textContent==='00:00:15'&&c.remainingLabel.textContent==='00:00:05'});
  c.resetPlaybackClock(900);c.updateMeter(900);
  result('Saved position does not distort initial estimate',{pass:c.elapsedLabel.textContent==='00:00:00'&&c.remainingLabel.textContent==='00:00:07'});
  c.rateSlider.value='2';c.resetTimeEstimate(900);c.updateMeter(900);
  result('Speed change resets remaining-time sample',{pass:c.remainingLabel.textContent==='00:00:03'});
  c.startPlaybackClock();now+=2000;c.resetTimeEstimate(500);c.updateMeter(500);
  result('Seek excludes skipped text from estimate',{pass:c.remainingLabel.textContent==='00:00:17'});

  c=context();now=0;c.Date={now:()=>now};c.queue=['Device speech'];c.currentVoiceIndex='-1';c.browserVoices=[];
  c.SpeechSynthesisUtterance=function(text){this.text=text;};c.speechSynthesis={speak(){}};
  vm.runInContext(section('function speakNextChunk(', '/* ========== PROGRESS'),c);
  c.isSpeaking=true;c.speakNextChunk('-1');now=30000;
  result('Device queue wait is not listening time',{pass:c.playbackSeconds()===0});
  c.utter.onstart();now+=3000;c.utter.onpause();now+=60000;
  result('Device pause freezes clock',{pass:c.playbackSeconds()===3});
  c.utter.onresume();now+=2000;c.utter.onend();
  result('Device resume and completion preserve active time',{pass:c.playbackSeconds()===5});
  const oldStart=c.utter.onstart;c.resetPlaybackClock();c.browserSession++;c.isSpeaking=true;oldStart();now+=5000;
  result('Stale device callback cannot start a new clock',{pass:c.playbackSeconds()===0});

  c=context();
  result('iPhone hides ineffective web volume control',{pass:c.usesDeviceVolumeButtons({userAgent:'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)',platform:'iPhone',maxTouchPoints:5})});
  result('Desktop-mode iPad hides ineffective web volume control',{pass:c.usesDeviceVolumeButtons({userAgent:'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15)',platform:'MacIntel',maxTouchPoints:5})});
  result('Desktop keeps adjustable web volume control',{pass:!c.usesDeviceVolumeButtons({userAgent:'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',platform:'Win32',maxTouchPoints:0})});
  result('Hidden iOS volume slider stays hidden',{pass:/\.slider\[hidden\]\s*\{\s*display:\s*none/.test(styles)});

  c=context();c.legacyCalls=0;c.useNeuralSpeechLegacy=()=>{c.legacyCalls++;};
  const compatibilityTask=c.useTimedNeuralSpeech('Sonia');
  const missing=new Error('timed endpoint unavailable');missing.legacy=true;
  c.fetches[0].reject(missing);await compatibilityTask;
  result('Approved fix: old endpoint must not switch voices',{pass:c.legacyCalls===0&&!c.isSpeaking,legacyCalls:c.legacyCalls,status:c.status});
  if(failures) throw new Error(`${failures} regression checks failed`);
  console.log('All lifecycle regression checks passed.');
})().catch(e=>{console.error(e);process.exitCode=1;});
