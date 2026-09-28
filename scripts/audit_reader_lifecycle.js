// Read-only audit harness: executes the actual reader functions in an isolated
// JS context with delayed network/audio adapters. No production traffic.
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const source = fs.readFileSync(path.join(__dirname, '..', 'readaloud.js'), 'utf8');
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
    setTimeout: () => 1, clearTimeout(){}, requestAnimationFrame(){},
    txt: {value:'Original passage.'}, rateSlider:{value:'1'}, volSlider:{value:'1'},
    isSpeaking:false, isPaused:false, currentAudio:null, sharedAudio:null,
    timed:null, timedCache:null, lastRead:null, preparedDownload:null,
    downloadBlobs:[], progChar:0, totalChars:0, startTime:0,
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
    finish(){ctx.isSpeaking=false;ctx.timed=null;},
    URL:{createObjectURL(){return 'blob:test';},revokeObjectURL(){}},
    document:{createElement(){return {click(){ctx.downloads.push(this.download);}};}},
    fetchTimedSegment(seg,voice){const d=deferred();ctx.fetches.push({seg,voice,...d});return d.promise;},
    playTimedSegment(seg){ctx.played.push({text:seg.text,paused:ctx.isPaused,voice:ctx.timed.voiceId}); return new Promise(()=>{});},
  };
  vm.createContext(ctx);
  vm.runInContext(section('async function useTimedNeuralSpeech(', '// Play one fetched segment'),ctx);
  vm.runInContext(section('async function downloadMp3()', '/* ========== SUBTITLE EXPORT'),ctx);
  vm.runInContext(section('function progressLoop()', 'function buildDisplay()'),ctx);
  vm.runInContext(section('function populateVoiceSel()', 'function updateVoiceStatus()'),ctx);
  return ctx;
}
function result(name,evidence){console.log(JSON.stringify({name,...evidence}));}
(async()=>{
  let c=context();
  c.useTimedNeuralSpeech('Sonia'); c.isPaused=true;
  c.fetches[0].seg.blob=new Blob(['audio']);c.fetches[0].resolve();await tick();
  result('Pause during loading',{bug:c.played.some(p=>p.paused),played:c.played});

  c=context(); c.useTimedNeuralSpeech('Sonia');
  c.isSpeaking=false;c.timed=null; // Stop, followed by a new Start.
  c.txt.value='New passage.';c.useTimedNeuralSpeech('Guy');
  c.fetches[0].seg.blob=new Blob(['old audio']);c.fetches[0].resolve();await tick();
  result('Late response after Stop and new Start',{bug:c.played.some(p=>p.text==='Original passage.'),played:c.played});

  c=context();c.useTimedNeuralSpeech('Sonia');c.isSpeaking=false;c.timed=null;
  c.txt.value='New passage.';c.useTimedNeuralSpeech('Guy');
  c.fetches[0].reject(new Error('old request failed'));await tick();
  result('Old failure cancels new reading',{bug:!c.isSpeaking,newSession:c.timed,status:c.status});

  c=context();c.isSpeaking=true;c.timed={curSeg:null};c.totalChars=1000;
  c.startTime=Date.now()-10000;c.progressLoop();
  result('Progress while still loading',{bug:c.progChar>0,unspokenCharsMarkedRead:c.progChar});

  c=context();c.lastRead={key:'old',voiceId:'Sonia',segments:[{text:'Old export',start:0,end:10}]};
  const exportTask=c.downloadMp3();
  c.lastRead=null;c.preparedDownload=null;c.$('download').disabled=true;
  c.fetches[0].seg.blob=new Blob(['old audio']);c.fetches[0].resolve();await exportTask;
  result('Text edited while MP3 is preparing',{bug:c.downloads.length>0,downloaded:c.downloads,buttonReenabled:!c.$('download').disabled});

  c=context();c.rateSlider.value='0.8';
  c.lastRead={key:'same',voiceId:'Sonia',segments:[{text:'Part one'},{text:'Part two'}]};
  const first=deferred();
  c.fetchChunkWithRetry=async()=>{c.rates.push(c.rateSlider.value);if(c.rates.length===1)await first.promise;return new Blob(['audio']);};
  const rateTask=c.downloadMp3();c.rateSlider.value='1.5';first.resolve();await rateTask;
  result('Speed changed during MP3 preparation',{bug:new Set(c.rates).size>1,rates:c.rates,filename:c.downloads[0]});

  c=context();
  c.langSel={value:'en'};c.voiceSel={value:'browser:-1',options:[],appendChild(group){this.options.push(...group.children);}};
  c.document={createElement(){return {children:[],appendChild(child){this.children.push(child);}};}};
  c.browserVoices=[];c.NEURAL_VOICES={en:[{id:'Aria',name:'Aria',gender:'Female'}]};
  c.apiAvailable=true;c.updateVoiceStatus=()=>{};c.populateVoiceSel();
  result('Premium service recovers after automatic browser fallback',{bug:c.voiceSel.value==='browser:-1',selected:c.voiceSel.value});

  c=context();c.txt.value='A long reading. '.repeat(100);c.loadPosition=()=>100;
  c.useTimedNeuralSpeech('Sonia');
  result('Saved positions in the first 200 characters',{bug:c.timed.seekChar===null,saved:100,resumeTarget:c.timed.seekChar});

  c=context();c.legacyCalls=0;c.useNeuralSpeechLegacy=()=>{c.legacyCalls++;};
  const compatibilityTask=c.useTimedNeuralSpeech('Sonia');
  const missing=new Error('timed endpoint unavailable');missing.legacy=true;
  c.fetches[0].reject(missing);await compatibilityTask;
  result('Approved fix: old endpoint must not switch voices',{pass:c.legacyCalls===0&&!c.isSpeaking,legacyCalls:c.legacyCalls,status:c.status});
})().catch(e=>{console.error(e);process.exitCode=1;});
