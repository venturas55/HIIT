import Tuna from 'tunajs';
import SoundIterator from './sound_iterator'
var Wad = (function(){
    var audioContext = window.AudioContext || window.webkitAudioContext;
    var logStuff = {
        verbosity: 0,
        suppressedLogs: 0
    }
    var logMessage = function(message, logLevel){
        var logLevel = logLevel || 1
        if ( logStuff.verbosity >= logLevel ) {
            console.log(message)
        } 
        else { logStuff.suppressedLogs++ }
    }
    
    var aScene = document.querySelector('a-scene');
    var context;
    if ( aScene && aScene.audioListener && aScene.audioListener.context){
        context = aScene.audioListener.context
        logMessage("An A-Frame scene has been detected.")
    }
    else {
        context = new audioContext();
    }
    var unlock = function(){
        if ( context.state === 'suspended' ) {
            context.resume()
        }
        else if ( context.state === 'running' ) {
            logMessage("The audio context is running.")
            logMessage(context)
            window.removeEventListener('mousemove', unlock)
            window.removeEventListener('touchstart', unlock)
            window.removeEventListener('touchend', unlock)
        }
    }
    window.addEventListener('mousemove', unlock)
    window.addEventListener('touchstart', unlock)
    window.addEventListener('touchend', unlock)
    // create a wrapper for old versions of `getUserMedia`
    var getUserMedia = (function(window) {
        if (window.navigator.mediaDevices && window.navigator.mediaDevices.getUserMedia) {
            // Browser supports promise based `getUserMedia`
            return window.navigator.mediaDevices.getUserMedia.bind(window.navigator.mediaDevices);
        }
        var navigatorGetUserMedia = window.navigator.getUserMedia || window.navigator.webkitGetUserMedia || window.navigator.mozGetUserMedia;
        if (navigatorGetUserMedia) {
            // Browser supports old `getUserMedia` with callbacks.
            return function(constraints) {
                return new Promise(function(resolve, reject) {
                    navigatorGetUserMedia.call(window.navigator, constraints, resolve, reject);
                });
            };
        }
    
        return function() {
            throw "getUserMedia is unsupported";
        };
    }(window));
    
    if (getUserMedia) { logMessage("Your browser supports getUserMedia."); }
    else { logMessage("Your browser does not support getUserMedia."); }
/** Pre-render a noise buffer instead of generating noise on the fly. **/
    var noiseBuffer = (function(){
        // the initial seed
        Math.seed = 6;
        Math.seededRandom = function(max, min){
            max = max || 1;
            min = min || 0;
            Math.seed = ( Math.seed * 9301 + 49297 ) % 233280;
            var rnd = Math.seed / 233280;
            return min + rnd * (max - min);
        }
        var bufferSize = 2 * context.sampleRate;
        var noiseBuffer = context.createBuffer(1, bufferSize, context.sampleRate);
        var output = noiseBuffer.getChannelData(0);
        for ( var i = 0; i < bufferSize; i++ ) {
            output[i] = Math.seededRandom() * 2 - 1;
        }
        return noiseBuffer;
    })()
/////////////////////////////////////////////////////////////////////////
/** a lil hack. just be glad it isn't on Object.prototype. **/
    var isArray = function(object){
        return Object.prototype.toString.call(object) === '[object Array]';
    }
/** Set up the default ADSR envelope. **/
    var constructEnv = function(that, arg){
        that.env = { //default envelope, if one is not specified on play
            attack  : arg.env ? valueOrDefault(arg.env.attack,  0) : 0,    // time in seconds from onset to peak volume
            decay   : arg.env ? valueOrDefault(arg.env.decay,   0) : 0,    // time in seconds from peak volume to sustain volume
            sustain : arg.env ? valueOrDefault(arg.env.sustain, 1) : 1,    // sustain volume level, as a percent of peak volume. min:0, max:1
            hold    : arg.env ? valueOrDefault(arg.env.hold, 3.14159) : 3.14159, // time in seconds to maintain sustain volume
            release : arg.env ? valueOrDefault(arg.env.release, 0) : 0     // time in seconds from sustain volume to zero volume
        };
        that.defaultEnv = {
            attack  : arg.env ? valueOrDefault(arg.env.attack,  0) : 0,    // time in seconds from onset to peak volume
            decay   : arg.env ? valueOrDefault(arg.env.decay,   0) : 0,    // time in seconds from peak volume to sustain volume
            sustain : arg.env ? valueOrDefault(arg.env.sustain, 1) : 1,    // sustain volume level, as a percent of peak volume. min:0, max:1
            hold    : arg.env ? valueOrDefault(arg.env.hold, 3.14159) : 3.14159, // time in seconds to maintain sustain volume
            release : arg.env ? valueOrDefault(arg.env.release, 0) : 0     // time in seconds from sustain volume to zero volume
        };
        that.userSetHold = !!(arg.env && arg.env.hold)
    }
/////////////////////////////////////////
/** Set up the default filter and filter envelope. **/
    var constructFilter = function(that, arg){
        if ( !arg.filter ) { arg.filter = null; }
        else if ( isArray(arg.filter) ) {
            that.filter = arg.filter.map(function(filterArg){
                return {
                    type : filterArg.type || 'lowpass',
                    frequency : filterArg.frequency || 600,
                    q : filterArg.q || 1,
                    env : filterArg.env || null,
                }
            });
        }
        else {
            that.filter  = [{
                type : arg.filter.type || 'lowpass',
                frequency : arg.filter.frequency || 600,
                q : arg.filter.q || 1,
                env : arg.filter.env ||null,
            }];
        }
    }
//////////////////////////////////////////////////////
/** If the Wad uses an audio file as the source, request it from the server.
Don't let the Wad play until all necessary files have been downloaded. **/
    var requestAudioFile = function(that, callback){
        var request = new XMLHttpRequest();
        request.open("GET", that.source, true);
        request.responseType = "arraybuffer";
        that.playable--;
        request.onload = function(){
            context.decodeAudioData(request.response, function (decodedBuffer){
                that.decodedBuffer = decodedBuffer;
                if ( that.env.hold === 3.14159 ) { // audio buffers should not use the default hold
                    that.defaultEnv.hold = that.decodedBuffer.duration
                    that.env.hold = that.decodedBuffer.duration
                }
                that.duration = (that.env.attack + that.env.decay + that.env.hold + that.env.release) * (1/(that.rate)) * 1000
                if ( callback ) { callback(that); }
                that.playable++;
                if ( that.playOnLoad ) { that.play(that.playOnLoadArg); }
            })
        };
        request.send();
    };
//////////////////////////////////////////////////////////////////////////
/** Set up the vibrato LFO **/
    var constructVibrato = function(that, arg){
        if ( arg.vibrato ) {
            that.vibrato = {
                shape     : valueOrDefault(arg.vibrato.shape, 'sine'),
                speed     : valueOrDefault(arg.vibrato.speed, 1),
                magnitude : valueOrDefault(arg.vibrato.magnitude, 5),
                attack    : valueOrDefault(arg.vibrato.attack, 0)
            };
        }
        else { that.vibrato = null; }
    };
//////////////////////////////
/** Set up the tremolo LFO **/
    var constructTremolo = function(that, arg){
        if ( arg.tremolo ) {
            that.tremolo = {
                shape     : valueOrDefault(arg.tremolo.shape, 'sine'),
                speed     : valueOrDefault(arg.tremolo.speed, 1),
                magnitude : valueOrDefault(arg.tremolo.magnitude, 5),
                attack    : valueOrDefault(arg.tremolo.attack, 1)
            };
        }
        else { that.tremolo = null; }
    };
//////////////////////////////
/** Grab the reverb impulse response file from a server.
You may want to change Wad.defaultImpulse to serve files from your own server.
Check out http://www.voxengo.com/impulses/ for free impulse responses. **/
    var constructReverb = function(that, arg){
        if ( arg.reverb ) {
            that.reverb = { wet : valueOrDefault(arg.reverb.wet, 1) };
            var impulseURL = arg.reverb.impulse || Wad.defaultImpulse;
            var request = new XMLHttpRequest();
            request.open("GET", impulseURL, true);
            request.responseType = "arraybuffer";
            that.playable--;
            request.onload = function(){
                context.decodeAudioData(request.response, function (decodedBuffer){
                    that.reverb.buffer = decodedBuffer;
                    that.playable++;
                    if ( that.playOnLoad ) { that.play(that.playOnLoadArg); }
                    if ( that instanceof Wad.Poly ) { that.setUp(arg); }
                    if ( that.source === 'mic' && that.reverb && that.reverb.buffer && that.reverb.node && !that.reverb.node.buffer ) { // I think this is only relevant when calling play() with args on a mic
                        that.reverb.node.convolver.buffer = that.reverb.buffer;
                    }
                })
            };
            request.send();
        }
        else {
            that.reverb = null;
        }
    };
    var constructPanning = function(that, arg){
        if ( 'panning' in arg ) {
            that.panning = { location : arg.panning };
            if ( typeof(arg.panning) === "number" ) {
                that.panning.type = 'stereo';
            }
            else {
                that.panning.type = '3d'
                that.panning.panningModel   = arg.panningModel || 'equalpower';
                that.panning.distanceModel  = arg.distanceModel 
                that.panning.maxDistance    = arg.maxDistance 
                that.panning.rolloffFactor  = arg.rolloffFactor
                that.panning.refDistance    = arg.refDistance
                that.panning.coneInnerAngle = arg.coneInnerAngle
                that.panning.coneOuterAngle = arg.coneOuterAngle
                that.panning.coneOuterGain  = arg.coneOuterGain
            }
        }
        else {
            that.panning = {
                location : 0,
                type     : 'stereo',
            };
        }
        if ( that.panning.type === 'stereo' && !context.createStereoPanner ) {
            logMessage("Your browser does not support stereo panning. Falling back to 3D panning.")
            that.panning = {
                location     : [0,0,0],
                type         : '3d',
                panningModel : 'equalpower',
            }
        }
    };
//////////////////////////////////////////////////////////////////////////////
    var constructDelay = function(that, arg){
        if ( arg.delay ) {
            that.delay = {
                delayTime    : valueOrDefault(arg.delay.delayTime, .5),
                maxDelayTime : valueOrDefault(arg.delay.maxDelayTime, 2),
                feedback     : valueOrDefault(arg.delay.feedback, .25),
                wet          : valueOrDefault(arg.delay.wet, .25)
            };
        }
        else { that.delay = null; }
    };
/** Special initialization and configuration for microphone Wads **/
    var getConsent = function(that, arg) {
        that.nodes             = [];
        that.mediaStreamSource = null;
        that.gain              = null;
        return getUserMedia({audio: true, video: false}).then(function(stream) {
            that.mediaStreamSource = context.createMediaStreamSource(stream);
            Wad.micConsent = true
            setUpMic(that, arg);
            return that;
        }).catch(function(error) { logMessage('Error setting up microphone input: ', error); }); // This is the error callback.
    };
////////////////////////////////////////////////////////////////////
    var setUpMic = function(that, arg){
        that.nodes           = [];
        that.gain            = context.createGain();
        that.gain.gain.value = valueOrDefault(arg.volume,that.volume);
        that.nodes.push(that.mediaStreamSource);
        that.nodes.push(that.gain);
  
        if ( that.filter || arg.filter ) { createFilters(that, arg); }
        if ( that.reverb || arg.reverb ) { setUpReverbOnPlay(that, arg); }
        constructPanning(that, arg);
        setUpPanningOnPlay(that, arg);
        if ( that.delay || arg.delay ) {
            setUpDelayOnPlay(that, arg);
        }
        setUpTunaOnPlay(that, arg)
        that.setUpExternalFxOnPlay(arg, context);
    }
    var allWads = []
    var Wad = function(arg){
/** Set basic Wad properties **/
        this.source        = arg.source;
        this.destination   = arg.destination || context.destination; // the last node the sound is routed to
        this.volume        = valueOrDefault(arg.volume, 1); // peak volume. min:0, max:1 (actually max is infinite, but ...just keep it at or below 1)
        this.defaultVolume = this.volume;
        this.playable      = 1; // if this is less than 1, this Wad is still waiting for a file to download before it can play
        this.pitch         = Wad.pitches[arg.pitch] || arg.pitch || 440;
        this.gain          = [];
        this.detune        = arg.detune || 0; // In Cents.
        this.globalReverb  = arg.globalReverb || false;
        this.offset        = arg.offset || 0;
        this.loop          = arg.loop   || false;
        this.tuna          = arg.tuna   || null;
        this.rate          = arg.rate   || 1;
        this.sprite        = arg.sprite || null;
        constructEnv(this, arg);
        constructFilter(this, arg);
        constructVibrato(this, arg);
        constructTremolo(this, arg);
        constructReverb(this, arg);
        this.constructExternalFx(arg, context);
        constructPanning(this, arg);
        constructDelay(this, arg);
        this.duration = (this.env.attack + this.env.decay + this.env.hold + this.env.release) * (1/(this.rate)) * 1000
////////////////////////////////
/** If the Wad's source is noise, set the Wad's buffer to the noise buffer we created earlier. **/
        if ( this.source === 'noise' ) {
            this.decodedBuffer = noiseBuffer;
        }
//////////////////////////////////////////////////////////////////////////////////////////////////
/** If the Wad's source is the microphone, the rest of the setup happens here. **/
        else if ( this.source === 'mic' ) {
            getConsent(this, arg);
        }
//////////////////////////////////////////////////////////////////////////////////
/** If the source is not a pre-defined value, assume it is a URL for an audio file, and grab it now. **/
        else if ( !( this.source in { 'sine' : 0, 'sawtooth' : 0, 'square' : 0, 'triangle' : 0 } ) ) {
            requestAudioFile(this, arg.callback);
            if ( this.sprite ) {
                var thatWad = this;
                for ( var sprite in this.sprite ) {
                    this[sprite] = {
                        sprite: this.sprite[sprite],
                        play: function(arg){
                            arg = arg || {}
                            arg.env = arg.env || {}
                            arg.env.hold = this.sprite[1] - this.sprite[0]
                            arg.offset = this.sprite[0]
                            return thatWad.play(arg)
                        }
                    }
                }
            }
        }
////////////////////////////////////////////////////////////////////////////////////////////////////////
        else { arg.callback && arg.callback(this) }
        allWads.push(this)
    };
    Wad.allWads = allWads
    Wad.micConsent = false
    Wad.audioContext = context
    if ( typeof Tuna != undefined ) {
        Wad.tuna = new Tuna(Wad.audioContext)
    }
/** When a note is played, these two functions will schedule changes in volume and filter frequency,
as specified by the volume envelope and filter envelope **/
    var filterEnv = function(wad, arg){
        wad.filter.forEach(function (filter, index){
            filter.node.frequency.linearRampToValueAtTime(filter.frequency, arg.exactTime);
            filter.node.frequency.linearRampToValueAtTime(filter.env.frequency, arg.exactTime + filter.env.attack);
        });
    };
    var playEnv = function(wad, arg){
        var loop = arg.loop || arg.loop
        if ( wad.env.hold === -1 || (loop && !wad.userSetHold && !(arg.env && arg.env.hold) ) ){
            var hold = 999
        }
        else { var hold = wad.env.hold }
        wad.gain[0].gain.linearRampToValueAtTime(0.0001, arg.exactTime);
        wad.gain[0].gain.linearRampToValueAtTime(wad.volume, arg.exactTime + wad.env.attack + 0.00001);
        wad.gain[0].gain.linearRampToValueAtTime(wad.volume * wad.env.sustain, arg.exactTime + wad.env.attack + wad.env.decay + 0.00002);
        wad.gain[0].gain.linearRampToValueAtTime(wad.volume * wad.env.sustain, arg.exactTime + wad.env.attack + wad.env.decay + hold + 0.00003);
        wad.gain[0].gain.linearRampToValueAtTime(0.0001, arg.exactTime + wad.env.attack + wad.env.decay + hold + wad.env.release + 0.00004);
        // offset is only used by BufferSourceNodes. OscillatorNodes should safely ignore the offset.
        wad.soundSource.start(arg.exactTime, arg.offset);
        wad.soundSource.stop(arg.exactTime + wad.env.attack + wad.env.decay + hold + wad.env.release);
    };
////////////////////////////////////////////////////////////////////////////////////////////////////
/** When all the nodes are set up for this Wad, this function plugs them into each other,
with special handling for nodes with custom interfaces (e.g. reverb, delay). **/
    var plugEmIn = function(that, arg){
        var destination = ( arg && arg.destination ) || that.destination;
        for ( var i = 1; i < that.nodes.length; i++ ) {
            if ( that.nodes[i-1].interface === 'custom' ) {
                var from = that.nodes[i-1].output;
            }
            else { // assume native interface
                var from = that.nodes[i-1];
            }
            if ( that.nodes[i].interface === 'custom' ) {
                var to = that.nodes[i].input
            }
            else { // assume native interface
                var to = that.nodes[i]
            }
            from.connect(to);
        }
        if ( that.nodes[that.nodes.length-1].interface === 'custom') {
            var lastStop = that.nodes[that.nodes.length-1].output;
        }
        else { // assume native interface
            var lastStop = that.nodes[that.nodes.length-1];
        }
        lastStop.connect(destination);
        /** Global reverb is super deprecated, and should be removed at some point. **/
        if ( Wad.reverb && that.globalReverb ) {
            that.nodes[that.nodes.length - 1].connect(Wad.reverb.node);
            Wad.reverb.node.connect(Wad.reverb.gain);
            Wad.reverb.gain.connect(destination);
        }
        /**************************************************************************/
    };
/////////////////////////////////////////////////////////////////////////////////////////
/** Initialize and configure an oscillator node **/
    var setUpOscillator = function(that, arg){
        arg = arg || {};
        that.soundSource = context.createOscillator();
        that.soundSource.type = that.source;
        if ( arg.pitch ) {
            if ( arg.pitch in Wad.pitches ) {
                that.soundSource.frequency.value = Wad.pitches[arg.pitch];
            }
            else {
                that.soundSource.frequency.value = arg.pitch;
            }
        }
        else {
            that.soundSource.frequency.value = that.pitch;
        }
    };
///////////////////////////////////////////////////
/** Set the ADSR volume envelope according to play() arguments, or revert to defaults **/
    var setUpEnvOnPlay = function(that, arg){
        if ( arg && arg.env ) {
            that.env.attack  = valueOrDefault(arg.env.attack, that.defaultEnv.attack);
            that.env.decay   = valueOrDefault(arg.env.decay, that.defaultEnv.decay);
            that.env.sustain = valueOrDefault(arg.env.sustain, that.defaultEnv.sustain);
            that.env.hold    = valueOrDefault(arg.env.hold, that.defaultEnv.hold);
            that.env.release = valueOrDefault(arg.env.release, that.defaultEnv.release);
        }
        else {
            that.env = {
                attack  : that.defaultEnv.attack,
                decay   : that.defaultEnv.decay,
                sustain : that.defaultEnv.sustain,
                hold    : that.defaultEnv.hold,
                release : that.defaultEnv.release
            };
        }
    };
//////////////////////////////////////////////////////////////////////////////////
/** Set the filter and filter envelope according to play() arguments, or revert to defaults **/
    var createFilters = function(that, arg){
        if ( arg.filter && !isArray(arg.filter) ) {
            arg.filter = [arg.filter];
        }
        that.filter.forEach(function (filter, i) {
            filter.node                 = context.createBiquadFilter();
            filter.node.type            = filter.type;
            filter.node.frequency.value = ( arg.filter && arg.filter[i] ) ? ( arg.filter[i].frequency || filter.frequency ) : filter.frequency;
            filter.node.Q.value         = ( arg.filter && arg.filter[i] ) ? ( arg.filter[i].q         || filter.q )         : filter.q;
            if ( ( arg.filter && arg.filter[i].env || that.filter[i].env ) && !( that.source === "mic" ) ) {
                filter.env = {
                    attack    : ( arg.filter && arg.filter[i].env && arg.filter[i].env.attack )    || that.filter[i].env.attack,
                    frequency : ( arg.filter && arg.filter[i].env && arg.filter[i].env.frequency ) || that.filter[i].env.frequency
                };
            }
            that.nodes.push(filter.node);
        })
    };
    var setUpFilterOnPlay = function(that, arg){
        if ( arg && arg.filter && that.filter ) {
            if ( !isArray(arg.filter) ) arg.filter = [arg.filter]
            createFilters(that, arg)
        }
        else if ( that.filter ) {
            createFilters(that, that);
        }
    };
///////////////////////////////////////////////////////////////////////////////////////////////
/** Initialize and configure a convolver node for playback **/
    var setUpReverbOnPlay = function(that, arg){
        var reverbNode = {
            interface : 'custom',
            input : context.createGain(),
            convolver : context.createConvolver(),
            wet : context.createGain(),
            output : context.createGain()
        }
        reverbNode.convolver.buffer = that.reverb.buffer;
        reverbNode.wet.gain.value   = that.reverb.wet;
        reverbNode.input.connect(reverbNode.convolver);
        reverbNode.input.connect(reverbNode.output);
        reverbNode.convolver.connect(reverbNode.wet);
        reverbNode.wet.connect(reverbNode.output);
        that.reverb.node = reverbNode;
        that.nodes.push(that.reverb.node);
    };
//////////////////////////////////////////////////////////////
/** Initialize and configure a panner node for playback **/
    var setUpPanningOnPlay = function(that, arg){
        var panning = arg && arg.panning; // can be zero provided as argument
        if (typeof panning === 'undefined') { panning = that.panning.location; }
        if (typeof panning  === 'number') {
            that.panning.node = context.createStereoPanner();
            that.panning.node.pan.value = panning;
            that.panning.type = 'stereo';
        }
        else {
            that.panning.node = context.createPanner();
            that.panning.node.setPosition(panning[0], panning[1], panning[2]);
            that.panning.node.panningModel = arg.panningModel || that.panningModel || 'equalpower';
            that.panning.type = '3d';
            that.panning.node.distanceModel  = arg.distanceModel  || that.distanceModel  || that.panning.node.distanceModel
            that.panning.node.maxDistance    = arg.maxDistance    || that.maxDistance    || that.panning.node.maxDistance
            that.panning.node.rolloffFactor  = arg.rolloffFactor  || that.rolloffFactor  || that.panning.node.rolloffFactor
            that.panning.node.refDistance    = arg.refDistance    || that.refDistance    || that.panning.node.refDistance
            that.panning.node.coneInnerAngle = arg.coneInnerAngle || that.coneInnerAngle || that.panning.node.coneInnerAngle
            that.panning.node.coneOuterAngle = arg.coneOuterAngle || that.coneOuterAngle || that.panning.node.coneOuterAngle
            that.panning.node.coneOuterGain  = arg.coneOuterGain  || that.coneOuterGain  || that.panning.node.coneOuterGain
        }
        that.nodes.push(that.panning.node);
    };
///////////////////////////////////////////////////////////
/** Initialize and configure a vibrato LFO Wad for playback **/
    var setUpVibratoOnPlay = function(that, arg){
        that.vibrato.wad = new Wad({
            source : that.vibrato.shape,
            pitch  : that.vibrato.speed,
            volume : that.vibrato.magnitude,
            env    : {
                attack : that.vibrato.attack
            },
            destination : that.soundSource.frequency
        });
        that.vibrato.wad.play();
    };
///////////////////////////////////////////////////////////////
/** Initialize and configure a tremolo LFO Wad for playback **/
    var setUpTremoloOnPlay = function(that, arg){
        that.tremolo.wad = new Wad({
            source : that.tremolo.shape,
            pitch  : that.tremolo.speed,
            volume : that.tremolo.magnitude,
            env    : {
                attack : that.tremolo.attack,
                hold   : 10
            },
            destination : that.gain[0].gain
        });
        that.tremolo.wad.play();
    };
///////////////////////////////////////////////////////////////
    var setUpDelayOnPlay = function(that, arg){
        if ( that.delay ) {
            if ( !arg.delay ) { arg.delay = {}; }
            //create the nodes weâll use
            var delayNode = { // the custom delay node
                interface    : 'custom',
                input        : context.createGain(),
                output       : context.createGain(),
                delayNode    : context.createDelay(that.delay.maxDelayTime), // the native delay node inside the custom delay node.
                feedbackNode : context.createGain(),
                wetNode      : context.createGain(),
            }
            //set some decent values
            delayNode.delayNode.delayTime.value = valueOrDefault(arg.delay.delayTime, that.delay.delayTime);
            delayNode.feedbackNode.gain.value   = valueOrDefault(arg.delay.feedback, that.delay.feedback);
            delayNode.wetNode.gain.value        = valueOrDefault(arg.delay.wet, that.delay.wet);
            //set up the routing
            delayNode.input.connect(delayNode.delayNode);
            delayNode.input.connect(delayNode.output);
            delayNode.delayNode.connect(delayNode.feedbackNode);
            delayNode.delayNode.connect(delayNode.wetNode);
            delayNode.feedbackNode.connect(delayNode.delayNode);
            delayNode.wetNode.connect(delayNode.output);
            that.delay.delayNode = delayNode;
            that.nodes.push(delayNode)
        }
    };
/** **/
    var constructCompressor = function(that, arg){
        that.compressor = context.createDynamicsCompressor();
        that.compressor.attack.value    = valueOrDefault(arg.compressor.attack, that.compressor.attack.value);
        that.compressor.knee.value      = valueOrDefault(arg.compressor.knee, that.compressor.knee.value);
        that.compressor.ratio.value     = valueOrDefault(arg.compressor.ratio, that.compressor.ratio.value);
        that.compressor.release.value   = valueOrDefault(arg.compressor.release, that.compressor.release.value);
        that.compressor.threshold.value = valueOrDefault(arg.compressor.threshold, that.compressor.threshold.value);
        that.nodes.push(that.compressor);
    };
    var setUpTunaOnPlay = function(that, arg){
        if ( !( that.tuna || arg.tuna ) ) { return }
        var tunaConfig = {}
        if ( that.tuna ) {
            for ( var key in that.tuna ) {
                tunaConfig[key] = that.tuna[key]
            }
        }
        // overwrite settings from `this` with settings from arg
        if ( arg.tuna ) {
            for ( var key in arg.tuna ) {
                tunaConfig[key] = arg.tuna[key]
            }
        }
        for ( var key in tunaConfig) {
            var tunaEffect = new Wad.tuna[key](tunaConfig[key])
            that.nodes.push(tunaEffect)
        }
    }
///
/** Method to allow users to setup external fx in the constructor **/
    Wad.prototype.constructExternalFx = function(arg, context){
        //override me in your own code
    };
//////////////////////////////////////////////////////////////////////////////
/** To be overrided by the user **/
    Wad.prototype.setUpExternalFxOnPlay = function(arg, context){
        //user does what is necessary here, and then maybe does something like:
        // this.nodes.push(externalFX)
    };
///////////////////////////////////////////////////////////////
/** the play() method will create the various nodes that are required for this Wad to play,
set properties on those nodes according to the constructor arguments and play() arguments,
plug the nodes into each other with plugEmIn(),
then finally play the sound by calling playEnv() **/
    Wad.prototype.play = function(arg){
        arg = arg || { arg : null };
        if ( this.playable < 1 ) {
            this.playOnLoad    = true;
            this.playOnLoadArg = arg;
        }
        else if ( this.source === 'mic' ) {
            if ( Wad.micConsent ) {
                if ( arg.arg === null ) {
                    plugEmIn(this, arg);
                }
                else {
                    constructFilter(this, arg);
                    constructVibrato(this, arg);
                    constructTremolo(this, arg);
                    constructReverb(this, arg);
                    this.constructExternalFx(arg, context);
                    constructPanning(this, arg);
                    constructDelay(this, arg);
                    setUpMic(this, arg);
                    plugEmIn(this, arg);
                }
            }
            else { 
                logMessage('You have not given your browser permission to use your microphone.')
                getConsent(this, arg).then(function (that) {
                    that.play(arg);
                });
            }
        }
        else {
            this.nodes = [];
            if ( !arg.wait ) { arg.wait = 0; }
            if ( arg.volume ) { this.volume = arg.volume; }
            else { this.volume = this.defaultVolume; }
            arg.offset = arg.offset || this.offset || 0;
            if ( this.source in { 'sine' : 0, 'sawtooth' : 0, 'square' : 0, 'triangle' : 0 } ) {
                setUpOscillator(this, arg);
            }
            else {
                this.soundSource = context.createBufferSource();
                this.soundSource.buffer = this.decodedBuffer;
                if ( this.source === 'noise' || this.loop || arg.loop ) {
                    this.soundSource.loop = true;
                }
                
            }
            if ( this.soundSource.playbackRate ) {
                this.soundSource.playbackRate.value = arg.rate || this.rate;
            }
            if ( this.soundSource.detune ) {
                this.soundSource.detune.value = arg.detune || this.detune;
            }
            if ( arg.wait === undefined ) {
                arg.wait = 0;
            }
            if (arg.exactTime === undefined) {
                arg.exactTime = context.currentTime + arg.wait;
            }
            this.lastPlayedTime = arg.exactTime
            this.nodes.push(this.soundSource);
    /**  sets the volume envelope based on the play() arguments if present,
    or defaults to the constructor arguments if the volume envelope is not set on play() **/
            setUpEnvOnPlay(this, arg);
    ////////////////////////////////////////////////////////////////////////////////////////
    /**  sets up the filter and filter envelope based on the play() argument if present,
    or defaults to the constructor argument if the filter and filter envelope are not set on play() **/
            setUpFilterOnPlay(this, arg);
    ///////////////////////////////////////////////////////////////////////////////////////////////////
            setUpTunaOnPlay(this, arg);
            this.setUpExternalFxOnPlay(arg, context);
            this.gain.unshift(context.createGain()); // sets up the gain node
            this.gain[0].label = arg.label;
            this.nodes.push(this.gain[0]);
            if ( this.gain.length > 15 ) {
                this.gain.length = 15
            }
            // sets up reverb
            if ( this.reverb ) { setUpReverbOnPlay(this, arg); }
    /**  sets panning based on the play() argument if present, or defaults to the constructor argument if panning is not set on play **/
            setUpPanningOnPlay(this, arg);
    ////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
            setUpDelayOnPlay(this, arg);
            plugEmIn(this, arg);
            if ( this.filter && this.filter[0].env ) { filterEnv(this, arg); }
            playEnv(this, arg);
            //sets up vibrato LFO
            if ( this.vibrato ) { setUpVibratoOnPlay(this, arg); }
            //sets up tremolo LFO
            if ( this.tremolo ) { setUpTremoloOnPlay(this, arg); }
        }
        if ( arg.callback ) { arg.callback(this); }
        var thatWad = this
        return new Promise(function(resolve, reject){
            setTimeout(function(){
                resolve(thatWad)
            }, (arg.wait + thatWad.env.attack + thatWad.env.decay + thatWad.env.hold + thatWad.env.release) * (1/(arg.rate||thatWad.rate||1)) * 1000 )
        })
    };
//////////////////////////////////////////////////////////////////////////////////////////
    /** Change the volume of a Wad at any time, including during playback **/
    Wad.prototype.setVolume = function(volume){
        this.defaultVolume = volume;
        if ( this.gain.length > 0 ) { this.gain[0].gain.value = volume; }
        return this;
    };
    /**
    Change the playback rate of a Wad during playback.
    inputSpeed is a value of 0 < speed, and is the rate of playback of the audio.
    E.g. if input speed = 2.0, the playback will be twice as fast
    **/
    Wad.prototype.setRate = function(inputSpeed) {
        //Check/Save the input
        var speed;
        if(inputSpeed && inputSpeed > 0) speed = inputSpeed;
        else speed = 0;
        //Check if we have a soundsource (Though we always should)
        if(this.soundSource) {
            //Set the value
            this.soundSource.playbackRate.value = speed;
        }
        else {
            //Inform that there is no delay on the current wad
            logMessage("Sorry, but the wad does not contain a soundSource!");
        }
        return this;
    };
    Wad.prototype.setPitch = function(pitch){
        if ( pitch in Wad.pitches ) {
            if ( this.soundSource ) {
                this.soundSource.frequency.value = Wad.pitches[pitch];
            }
            this.pitch = Wad.pitches[pitch]
        }
        else {
            if ( this.soundSource ) {
                this.soundSource.frequency.value = pitch;
            }
            this.pitch = pitch
        }
        return this;
    };
    Wad.prototype.setDetune = function(detune, timeConstant){
        timeConstant = timeConstant || .01
        this.soundSource.detune.setTargetAtTime(detune, context.currentTime, timeConstant)
        return this;
    };
    /** Change the panning of a Wad at any time, including during playback **/
    Wad.prototype.setPanning = function(panning, timeConstant){
        timeConstant = timeConstant || .01
        this.panning.location = panning;
        if ( isArray(panning) && this.panning.type === '3d' && this.panning.node ) {
            this.panning.node.setPosition(panning[0], panning[1], panning[2]);
        }
        else if ( typeof panning === 'number' && this.panning.type === 'stereo' && this.panning.node) {
            this.panning.node.pan.setTargetAtTime(panning, context.currentTime, timeConstant)
        }
        if ( isArray(panning) ) { this.panning.type = '3d' }
        else if ( typeof panning === 'number' ) { this.panning.type = 'stereo' }
        return this;
    };
    /**
    Change the Reverb of a Wad at any time, including during playback.
    inputWet is a value of 0 < wetness/gain < 1
    **/
    Wad.prototype.setReverb = function(inputWet) {
        //Check/Save the input
        var wet;
        if(inputWet && inputWet > 0 && inputWet < 1) wet = inputWet;
        else if(inputWet >= 1) wet = 1;
        else wet = 0;
        //Check if we have delay
        if(this.reverb) {
            //Set the value
            this.reverb.wet = wet;
            //Set the node's value, if it exists
            if(this.reverb.node) {
                this.reverb.node.wet.gain.value = wet;
            }
        }
        else {
            //Inform that there is no reverb on the current wad
            logMessage("Sorry, but the wad does not contain Reverb!");
        }
        return this;
    };
    /**
    Change the Delay of a Wad at any time, including during playback.
    inputTime is a value of time > 0, and is the time in seconds between each delayed playback.
    inputWet is a value of gain 0 < inputWet < 1, and is Relative volume change between the original sound and the first delayed playback.
    inputFeedback is a value of gain 0 < inputFeedback < 1, and is Relative volume change between each delayed playback and the next.
    **/
    Wad.prototype.setDelay = function(inputTime, inputWet, inputFeedback){
        //Check/Save the input
        var time;
        if(inputTime && inputTime > 0) time = inputTime;
        else time = 0;
        var wet;
        if(inputWet && inputWet > 0 && inputWet < 1) wet = inputWet;
        else if(inputWet >= 1) wet = 1;
        else wet = 0;
        var feedback;
        if(inputFeedback && inputFeedback > 0 && inputFeedback < 1) feedback = inputFeedback;
        else if(inputFeedback >= 1) feedback = 1;
        else feedback = 0;
        //Check if we have delay
        if(this.delay) {
            //Set the value
            this.delay.delayTime = time;
            this.delay.wet = wet;
            this.delay.feedback = feedback;
            //Set the node's value, if it exists
            if(this.delay.delayNode) {
                this.delay.delayNode.delayNode.delayTime.value = time;
                this.delay.delayNode.wetNode.gain.value = wet;
                this.delay.delayNode.feedbackNode.gain.value = feedback;
            }
        }
        else {
            //Inform that there is no delay on the current wad
            logMessage("Sorry, but the wad does not contain delay!", 2);
        }
        return this;
    };
//////////////////////////////////////////////////////////////////////////////////////////
    Wad.prototype.pause = function(label){
        this.pauseTime = context.currentTime
        this.stop(label)
    }
    Wad.prototype.unpause = function(arg){
        arg = arg || {}
        if ( this.pauseTime && this.lastPlayedTime ) {
            arg.offset = this.pauseTime - this.lastPlayedTime
        }
        else { 
            logMessage("You tried to unpause a wad that was not played and paused, so it just played normally instead.", 2)
        }
        this.play(arg)
    }
/** If multiple instances of a sound are playing simultaneously, stop() only can stop the most recent one **/
    Wad.prototype.stop = function(label){
        if ( !( this.source === 'mic' ) ) {
            if ( !(this.gain && this.gain.length) ){
                logMessage("You tried to stop a Wad that never played. ", 2)
                logMessage(this, 2)
                return // if the wad has never been played, there's no need to stop it
            }
            else if ( label ) {
                for ( var i = 0; i < this.gain.length; i++ ) {
                    if ( this.gain[i].label === label ) {
                        this.gain[i].gain.cancelScheduledValues(context.currentTime);
                        this.gain[i].gain.setValueAtTime(this.gain[i].gain.value, context.currentTime);
                        this.gain[i].gain.linearRampToValueAtTime(.0001, context.currentTime + this.env.release);
                    }
                }
            }
            else if ( !label ) {
                this.gain[0].gain.cancelScheduledValues(context.currentTime);
                this.gain[0].gain.setValueAtTime(this.gain[0].gain.value, context.currentTime);
                this.gain[0].gain.linearRampToValueAtTime(.0001, context.currentTime + this.env.release);
            }
        }
        else if (Wad.micConsent ) {
            this.mediaStreamSource.disconnect(0);
        }
        else { logMessage('You have not given your browser permission to use your microphone.')}
        if ( this.tremolo ) {
            this.tremolo.wad.stop()
        }
    };
////////////////////////////////////////////////////////////////////////////////////////////////////////////////
    var buflen = 2048;
    var buf = new Uint8Array( buflen );
    var MINVAL = 134;  // 128 == zero.  MINVAL is the "minimum detected signal" level.
    var noteFromPitch = function( frequency ) {
        var noteNum = 12 * (Math.log( frequency / 440 )/Math.log(2) );
        return Math.round( noteNum ) + 69;
    }
    var frequencyFromNoteNumber = function( note ) {
        return 440 * Math.pow(2,(note-69)/12);
    }
    var centsOffFromPitch = function( frequency, note ) {
        return Math.floor( 1200 * Math.log( frequency / frequencyFromNoteNumber( note ))/Math.log(2) );
    }
    function autoCorrelate( buf, sampleRate ) {
        var MIN_SAMPLES = 4;    // corresponds to an 11kHz signal
        var MAX_SAMPLES = 1000; // corresponds to a 44Hz signal
        var SIZE = 1000;
        var best_offset = -1;
        var best_correlation = 0;
        var rms = 0;
        var foundGoodCorrelation = false;
        if (buf.length < (SIZE + MAX_SAMPLES - MIN_SAMPLES))
            return -1;  // Not enough data
        for ( var i = 0; i < SIZE; i++ ) {
            var val = ( buf[i] - 128 ) / 128;
            rms += val * val;
        }
        rms = Math.sqrt(rms/SIZE);
        if (rms<0.01)
            return -1;
        var lastCorrelation=1;
        for (var offset = MIN_SAMPLES; offset <= MAX_SAMPLES; offset++) {
            var correlation = 0;
            for (var i=0; i<SIZE; i++) {
                correlation += Math.abs(((buf[i] - 128)/128)-((buf[i+offset] - 128)/128));
            }
            correlation = 1 - (correlation/SIZE);
            if ((correlation>0.9) && (correlation > lastCorrelation))
                foundGoodCorrelation = true;
            else if (foundGoodCorrelation) {
                // short-circuit - we found a good correlation, then a bad one, so we'd just be seeing copies from here.
                return sampleRate/best_offset;
            }
            lastCorrelation = correlation;
            if (correlation > best_correlation) {
                best_correlation = correlation;
                best_offset = offset;
            }
        }
        if (best_correlation > 0.01) {
            // console.log("f = " + sampleRate/best_offset + "Hz (rms: " + rms + " confidence: " + best_correlation + ")")
            return sampleRate/best_offset;
        }
        return -1;
    //  var best_frequency = sampleRate/best_offset;
    }
    function volumeAudioProcess( event ) {
        var buf = event.inputBuffer.getChannelData(0);
        var bufLength = buf.length;
        var sum = 0;
        var x;
    
        // Do a root-mean-square on the samples: sum up the squares...
        for (var i=0; i<bufLength; i++) {
            x = buf[i];
            if (Math.abs(x)>=this.clipLevel) {
                this.clipping = true;
                this.lastClip = window.performance.now();
            }
            sum += x * x;
        }
    
        // ... then take the square root of the sum.
        var rms =  Math.sqrt(sum / bufLength);
    
        // Now smooth this out with the averaging factor applied
        // to the previous sample - take the max here because we
        // want "fast attack, slow release."
        this.volume = Math.max(rms, this.volume*this.averaging);
        // console.log('volume? ', this.volume)
    }
    function createAudioMeter(audioContext,clipLevel,averaging,clipLag) {
        var processor = audioContext.createScriptProcessor(512);
        processor.onaudioprocess = volumeAudioProcess;
        processor.clipping = false;
        processor.lastClip = 0;
        processor.volume = 0;
        processor.clipLevel = clipLevel || 0.98;
        processor.averaging = averaging || 0.95;
        processor.clipLag = clipLag || 750;
    
        // this will have no effect, since we don't copy the input to the output,
        // but works around a current Chrome bug.
        processor.connect(audioContext.destination);
    
        processor.checkClipping =
            function(){
                if (!this.clipping)
                    return false;
                if ((this.lastClip + this.clipLag) < window.performance.now())
                    this.clipping = false;
                return this.clipping;
            };
    
        processor.shutdown =
            function(){
                this.disconnect();
                this.onaudioprocess = null;
            };
    
        return processor;
    }
    Wad.Poly = function(arg){
        if ( !arg ) { arg = {}; }
        this.isSetUp  = false;
        this.playable = 1;
        if ( arg.reverb ) {
            constructReverb(this, arg); // We need to make sure we have downloaded the impulse response before continuing with the setup.
        }
        else {
            this.setUp(arg);
        }
    };
    Wad.Poly.prototype.setUp = function(arg){ // Anything that needs to happen before reverb is set up can go here.
        this.wads              = [];
        this.input             = context.createAnalyser();
        this.input.fftSize     = 2048
        this.nodes             = [this.input];
        this.destination       = arg.destination || context.destination; // the last node the sound is routed to
        this.volume            = arg.volume || 1;
        this.gain              = context.createGain();
        this.gain.gain.value   = this.volume;
        this.output            = context.createAnalyser();
        this.tuna              = arg.tuna || null;
        this.audioMeter        = null;
        if ( arg.audioMeter ) {
            this.audioMeter = createAudioMeter(context, arg.audioMeter.clipLevel, arg.audioMeter.averaging, arg.audioMeter.clipLag)
            this.output.connect(this.audioMeter);
        }
        this.globalReverb = arg.globalReverb || false; // deprecated
        constructFilter(this, arg);
        if ( this.filter ) { createFilters(this, arg); }
        if ( this.reverb ) { setUpReverbOnPlay(this, arg); }
        this.constructExternalFx(arg, context);
        constructPanning(this, arg);
        setUpPanningOnPlay(this, arg);
        if ( arg.compressor ) { constructCompressor(this, arg); }
        constructDelay(this, arg);
        setUpDelayOnPlay(this, arg);
        setUpTunaOnPlay(this, arg);
        this.nodes.push(this.gain);
        this.nodes.push(this.output);
        plugEmIn(this, arg);
        this.isSetUp = true;
        if ( arg.callback ) { arg.callback(this); }
    }
    Wad.SoundIterator = function(args){
        return new SoundIterator(args, Wad)
    }
/**
    The MIT License (MIT)
Copyright (c) 2014 Chris Wilson
**/
    Wad.Poly.prototype.updatePitch = function( time ) {
        this.input.getByteTimeDomainData( buf );
        var ac = autoCorrelate( buf, context.sampleRate );
        if ( ac !== -1 && ac !== 11025 && ac !== 12000 ) {
            var pitch = ac;
            this.pitch = Math.floor( pitch ) ;
            var note = noteFromPitch( pitch );
            this.noteName = Wad.pitchesArray[note - 12];
            // Detune doesn't seem to work.
            // var detune = centsOffFromPitch( pitch, note );
            // if (detune == 0 ) {
            //     this.detuneEstimate = 0;
            // } else {
            //     this.detuneEstimate = detune
            // }
        }
        var that = this;
        that.rafID = window.requestAnimationFrame( function(){ that.updatePitch() } );
    }
    Wad.Poly.prototype.stopUpdatingPitch = function(){
        cancelAnimationFrame(this.rafID)
    }
    Wad.Poly.prototype.setVolume = function(volume){
        if ( this.isSetUp ) {
            this.gain.gain.value = volume;
        }
        else {
            logMessage('This PolyWad is not set up yet.');
        }
        return this;
    }
    Wad.Poly.prototype.setPitch = function(pitch){
        this.wads.forEach(function(wad){
            
            if ( pitch in Wad.pitches ) {
                if ( wad.soundSource ) {
                    wad.soundSource.frequency.value = Wad.pitches[pitch];
                }
                wad.pitch = Wad.pitches[pitch]
            }
            else {
                if ( wad.soundSource ) {
                    wad.soundSource.frequency.value = pitch;
                }
                wad.pitch = pitch
            }
            return this;
        })
    }
    Wad.Poly.prototype.play = function(arg){
        if ( this.isSetUp ) {
            if ( this.playable < 1 ) {
                this.playOnLoad    = true;
                this.playOnLoadArg = arg;
            }
            else {
                if ( arg && arg.volume ) {
                    this.gain.gain.value = arg.volume; // if two notes are played with volume set as a play arg, does the second one overwrite the first? maybe input should be an array of gain nodes, like regular wads.
                    arg.volume = undefined; // if volume is set, it should change the gain on the polywad's gain node, NOT the gain nodes for individual wads inside the polywad.
                }
                for ( var i = 0; i < this.wads.length; i++ ) {
                    this.wads[i].play(arg);
                }
            }
        }
        else {
            logMessage('This PolyWad is not set up yet.');
        }
        return this;
    };
    Wad.Poly.prototype.stop = function(arg){
        if ( this.isSetUp ) {
            for ( var i = 0; i < this.wads.length; i++ ) {
                this.wads[i].stop(arg);
            }
        }
    };
    Wad.Poly.prototype.add = function(wad){
        if ( this.isSetUp ) {
            wad.destination = this.input;
            this.wads.push(wad);
            if ( wad instanceof Wad.Poly ) {
                wad.output.disconnect(0);
                wad.output.connect(this.input);
            }
        }
        else {
            logMessage('This PolyWad is not set up yet.');
        }
        return this;
    };
    Wad.Poly.prototype.remove = function(wad){
        if ( this.isSetUp ) {
            for ( var i = 0; i < this.wads.length; i++ ) {
                if ( this.wads[i] === wad ) {
                    this.wads[i].destination = context.destination;
                    this.wads.splice(i,1);
                    if ( wad instanceof Wad.Poly ) {
                        wad.output.disconnect(0);
                        wad.output.connect(context.destination);
                    }
                }
            }
        }
        return this;
    };
    Wad.Poly.prototype.constructExternalFx = function(arg, context){
    };
    Wad.stopAll = function(label){
        for ( var i = 0; i < Wad.allWads.length; i++ ) {
            Wad.allWads[i].stop(label)
        }
    }
    Wad.setVolume = function(volume){
        for ( var i = 0; i < Wad.allWads.length; i++ ) {
            Wad.allWads[i].setVolume(volume)
        }
    }
/** If a Wad is created with reverb without specifying a URL for the impulse response,
grab it from the defaultImpulse URL **/
    Wad.defaultImpulse = 'https://www.codecur.io/audio/widehall.wav';
    // This method is deprecated.
    Wad.setGlobalReverb = function(arg){
        Wad.reverb                 = {};
        Wad.reverb.node            = context.createConvolver();
        Wad.reverb.gain            = context.createGain();
        Wad.reverb.gain.gain.value = arg.wet;
        var impulseURL             = arg.impulse || Wad.defaultImpulse;
        var request                = new XMLHttpRequest();
        request.open("GET", impulseURL, true);
        request.responseType = "arraybuffer";
        request.onload = function() {
            context.decodeAudioData(request.response, function (decodedBuffer){
                Wad.reverb.node.buffer = decodedBuffer;
            });
        };
        request.send();
    };
//////////////////////////////////////////////////////////////////////////////////////
//  Utility function to avoid javascript type conversion bug checking zero values   //
    var valueOrDefault = function(value, def) {
        var val = (value == null) ? def : value;
        return val;
    };
//////////////////////////////////////////////////////////////////////////////////////
/** This object is a mapping of note names to frequencies. **/
    Wad.pitches = {
        'A0'  : 27.5000,
        'A#0' : 29.1352,
        'Bb0' : 29.1352,
        'B0'  : 30.8677,
        'B#0' : 32.7032,
        'Cb1' : 30.8677,
        'C1'  : 32.7032,
        'C#1' : 34.6478,
        'Db1' : 34.6478,
        'D1'  : 36.7081,
        'D#1' : 38.8909,
        'Eb1' : 38.8909,
        'E1'  : 41.2034,
        'Fb1' : 41.2034,
        'E#1' : 43.6535,
        'F1'  : 43.6535,
        'F#1' : 46.2493,
        'Gb1' : 46.2493,
        'G1'  : 48.9994,
        'G#1' : 51.9131,
        'Ab1' : 51.9131,
        'A1'  : 55.0000,
        'A#1' : 58.2705,
        'Bb1' : 58.2705,
        'B1'  : 61.7354,
        'Cb2' : 61.7354,
        'B#1' : 65.4064,
        'C2'  : 65.4064,
        'C#2' : 69.2957,
        'Db2' : 69.2957,
        'D2'  : 73.4162,
        'D#2' : 77.7817,
        'Eb2' : 77.7817,
        'E2'  : 82.4069,
        'Fb2' : 82.4069,
        'E#2' : 87.3071,
        'F2'  : 87.3071,
        'F#2' : 92.4986,
        'Gb2' : 92.4986,
        'G2'  : 97.9989,
        'G#2' : 103.826,
        'Ab2' : 103.826,
        'A2'  : 110.000,
        'A#2' : 116.541,
        'Bb2' : 116.541,
        'B2'  : 123.471,
        'Cb3' : 123.471,
        'B#2' : 130.813,
        'C3'  : 130.813,
        'C#3' : 138.591,
        'Db3' : 138.591,
        'D3'  : 146.832,
        'D#3' : 155.563,
        'Eb3' : 155.563,
        'E3'  : 164.814,
        'Fb3' : 164.814,
        'E#3' : 174.614,
        'F3'  : 174.614,
        'F#3' : 184.997,
        'Gb3' : 184.997,
        'G3'  : 195.998,
        'G#3' : 207.652,
        'Ab3' : 207.652,
        'A3'  : 220.000,
        'A#3' : 233.082,
        'Bb3' : 233.082,
        'B3'  : 246.942,
        'Cb4' : 246.942,
        'B#3' : 261.626,
        'C4'  : 261.626,
        'C#4' : 277.183,
        'Db4' : 277.183,
        'D4'  : 293.665,
        'D#4' : 311.127,
        'Eb4' : 311.127,
        'E4'  : 329.628,
        'Fb4' : 329.628,
        'E#4' : 349.228,
        'F4'  : 349.228,
        'F#4' : 369.994,
        'Gb4' : 369.994,
        'G4'  : 391.995,
        'G#4' : 415.305,
        'Ab4' : 415.305,
        'A4'  : 440.000,
        'A#4' : 466.164,
        'Bb4' : 466.164,
        'B4'  : 493.883,
        'Cb5' : 493.883,
        'B#4' : 523.251,
        'C5'  : 523.251,
        'C#5' : 554.365,
        'Db5' : 554.365,
        'D5'  : 587.330,
        'D#5' : 622.254,
        'Eb5' : 622.254,
        'E5'  : 659.255,
        'Fb5' : 659.255,
        'E#5' : 698.456,
        'F5'  : 698.456,
        'F#5' : 739.989,
        'Gb5' : 739.989,
        'G5'  : 783.991,
        'G#5' : 830.609,
        'Ab5' : 830.609,
        'A5'  : 880.000,
        'A#5' : 932.328,
        'Bb5' : 932.328,
        'B5'  : 987.767,
        'Cb6' : 987.767,
        'B#5' : 1046.50,
        'C6'  : 1046.50,
        'C#6' : 1108.73,
        'Db6' : 1108.73,
        'D6'  : 1174.66,
        'D#6' : 1244.51,
        'Eb6' : 1244.51,
        'Fb6' : 1318.51,
        'E6'  : 1318.51,
        'E#6' : 1396.91,
        'F6'  : 1396.91,
        'F#6' : 1479.98,
        'Gb6' : 1479.98,
        'G6'  : 1567.98,
        'G#6' : 1661.22,
        'Ab6' : 1661.22,
        'A6'  : 1760.00,
        'A#6' : 1864.66,
        'Bb6' : 1864.66,
        'B6'  : 1975.53,
        'Cb7' : 1975.53,
        'B#6' : 2093.00,
        'C7'  : 2093.00,
        'C#7' : 2217.46,
        'Db7' : 2217.46,
        'D7'  : 2349.32,
        'D#7' : 2489.02,
        'Eb7' : 2489.02,
        'E7'  : 2637.02,
        'Fb7' : 2637.02,
        'E#7' : 2793.83,
        'F7'  : 2793.83,
        'F#7' : 2959.96,
        'Gb7' : 2959.96,
        'G7'  : 3135.96,
        'G#7' : 3322.44,
        'Ab7' : 3322.44,
        'A7'  : 3520.00,
        'A#7' : 3729.31,
        'Bb7' : 3729.31,
        'B7'  : 3951.07,
        'Cb8' : 3951.07,
        'B#7' : 4186.01,
        'C8'  : 4186.01
    };
    Wad.pitchesArray = [ // Just an array of note names. This can be useful for mapping MIDI data to notes.
        'C0',
        'C#0',
        'D0',
        'D#0',
        'E0',
        'F0',
        'F#0',
        'G0',
        'G#0',
        'A0',
        'A#0',
        'B0',
        'C1',
        'C#1',
        'D1',
        'D#1',
        'E1',
        'F1',
        'F#1',
        'G1',
        'G#1',
        'A1',
        'A#1',
        'B1',
        'C2',
        'C#2',
        'D2',
        'D#2',
        'E2',
        'F2',
        'F#2',
        'G2',
        'G#2',
        'A2',
        'A#2',
        'B2',
        'C3',
        'C#3',
        'D3',
        'D#3',
        'E3',
        'F3',
        'F#3',
        'G3',
        'G#3',
        'A3',
        'A#3',
        'B3',
        'C4',
        'C#4',
        'D4',
        'D#4',
        'E4',
        'F4',
        'F#4',
        'G4',
        'G#4',
        'A4',
        'A#4',
        'B4',
        'C5',
        'C#5',
        'D5',
        'D#5',
        'E5',
        'F5',
        'F#5',
        'G5',
        'G#5',
        'A5',
        'A#5',
        'B5',
        'C6',
        'C#6',
        'D6',
        'D#6',
        'E6',
        'F6',
        'F#6',
        'G6',
        'G#6',
        'A6',
        'A#6',
        'B6',
        'C7',
        'C#7',
        'D7',
        'D#7',
        'E7',
        'F7',
        'F#7',
        'G7',
        'G#7',
        'A7',
        'A#7',
        'B7',
        'C8'
    ];
//////////////////////////////////////////////////////////////
    Wad.assignMidiMap = function(midiMap, which, success, failure){
        var which = which || 0;
        navigator.requestMIDIAccess().then(function(){
            if ( Wad.midiInputs[which] ) {
                Wad.midiInputs[which].onmidimessage = midiMap;
                if  ( typeof success === 'function' ) { success() }
            }
            else if ( typeof failure === 'function' ) { failure() }
        })
    }
    Wad.midiInstrument = {
        play : function() { logMessage('playing midi')  },
        stop : function() { logMessage('stopping midi') }
    };
    Wad.midiInputs  = [];
    var midiMap = function(event){
        logMessage(event.receivedTime, event.data, 2);
        if ( event.data[0] === 144 ) { // 144 means the midi message has note data
            if ( event.data[2] === 0 ) { // noteOn velocity of 0 means this is actually a noteOff message
                logMessage("Playing note: ", 2)
                logMessage(Wad.pitchesArray[event.data[1]-12], 2);
                Wad.midiInstrument.stop(Wad.pitchesArray[event.data[1]-12]);
            }
            else if ( event.data[2] > 0 ) {
                logMessage("Stopping note: ", 2)
                logMessage(Wad.pitchesArray[event.data[1]-12], 2);
                Wad.midiInstrument.play({pitch : Wad.pitchesArray[event.data[1]-12], label : Wad.pitchesArray[event.data[1]-12], callback : function(that){
                }})
            }
        }
        else if ( event.data[0] === 176 ) { // 176 means the midi message has controller data
            logMessage('controller');
            if ( event.data[1] == 46 ) {
                if ( event.data[2] == 127 ) { Wad.midiInstrument.pedalMod = true; }
                else if ( event.data[2] == 0 ) { Wad.midiInstrument.pedalMod = false; }
            }
        }
        else if ( event.data[0] === 224 ) { // 224 means the midi message has pitch bend data
            logMessage('pitch bend');
        }
    };
    var onSuccessCallback = function(midiAccess){
        Wad.midiInputs = []
        var val = midiAccess.inputs.values();
        for ( var o = val.next(); !o.done; o = val.next() ) {
            Wad.midiInputs.push(o.value)
        }
        // Wad.midiInputs = [m.inputs.values().next().value];   // inputs = array of MIDIPorts
        logMessage('MIDI inputs: ')
        logMessage(Wad.midiInputs)
        // var outputs = m.outputs(); // outputs = array of MIDIPorts
        for ( var i = 0; i < Wad.midiInputs.length; i++ ) {
            Wad.midiInputs[i].onmidimessage = midiMap; // onmidimessage( event ), event.data & event.receivedTime are populated
        }
        // var o = m.outputs()[0];           // grab first output device
        // o.send( [ 0x90, 0x45, 0x7f ] );     // full velocity note on A4 on channel zero
        // o.send( [ 0x80, 0x45, 0x7f ], window.performance.now() + 1000 );  // full velocity A4 note off in one second.
    };
    var onErrorCallback = function(err){
        logMessage("Failed to get MIDI access", err);
    };
    if ( navigator && navigator.requestMIDIAccess ) {
        try {
            navigator.requestMIDIAccess().then(onSuccessCallback, onErrorCallback);
        }
        catch(err) {
            logMessage("Failed to get MIDI access", err);
        }
    }
    Wad.presets = {
        hiHatClosed : { source : 'noise', env : { attack : .001, decay : .008, sustain : .2, hold : .03, release : .01}, filter : { type : 'highpass', frequency : 400, q : 1 } },
        snare : { source : 'noise', env : {attack : .001, decay : .01, sustain : .2, hold : .03, release : .02}, filter : {type : 'bandpass', frequency : 300, q : .180 } },
        hiHatOpen : { source : 'noise', env : { attack : .001, decay : .008, sustain : .2, hold : .43, release : .01}, filter : { type : 'highpass', frequency : 100, q : .2 } },
        ghost : { source : 'square', volume : .3, env : { attack : .01, decay : .002, sustain : .5, hold : 2.5, release : .3 }, filter : { type : 'lowpass', frequency : 600, q : 7, env : { attack : .7, frequency : 1600 } }, vibrato : { attack : 8, speed : 8, magnitude : 100 } },
        piano : { source : 'square', volume : 1.4, env : { attack : .01, decay : .005, sustain : .2, hold : .015, release : .3 }, filter : { type : 'lowpass', frequency : 1200, q : 8.5, env : { attack : .2, frequency : 600 } } }
    };
    Wad.logs = logStuff
    return Wad;
})()
if(typeof module !== 'undefined' && module.exports) {
    module.exports = Wad;
}
export default Wad;
