awmplayers.mews = {
  name: "MSE websocket player",
  mimes: ["ws/video/mp4", "ws/video/webm"],
  priority: AwmUtil.object.keys(awmplayers).length + 1,
  isMimeSupported: function (mimetype) {
    return (this.mimes.indexOf(mimetype) == -1 ? false : true);
  },
  isBrowserSupported: function (mimetype, source, AwmVideo) {

    if ((!("WebSocket" in window)) || (!("MediaSource" in window))) {
      return false;
    }

    //check for http/https mismatch
    if (location.protocol.replace(/^http/, "ws") != AwmUtil.http.url.split(source.url.replace(/^http/, "ws")).protocol) {
      AwmVideo.log("HTTP/HTTPS mismatch for this source");
      return false;
    }

    //it runs on MacOS, but breaks often on seek/track switch etc
    if (navigator.platform.toUpperCase().indexOf('MAC') >= 0) {
      return false;
    }

    //check (and save) codec compatibility
    function translateCodec(track) {
      function bin2hex(index) {
        return ("0" + track.init.charCodeAt(index).toString(16)).slice(-2);
      }

      switch (track.codec) {
        case "AAC":
          return "mp4a.40.2";
        case "MP3":
          return "mp4a.40.34";
        case "AC3":
          return "ec-3";
        case "H264":
          return "avc1." + bin2hex(1) + bin2hex(2) + bin2hex(3);
        case "HEVC":
          return "hev1." + bin2hex(1) + bin2hex(6) + bin2hex(7) + bin2hex(8) + bin2hex(9) + bin2hex(10) + bin2hex(11) + bin2hex(12);
        default:
          return track.codec.toLowerCase();
      }

    }

    var codecs = {};
    for (var i in AwmVideo.info.meta.tracks) {
      if (AwmVideo.info.meta.tracks[i].type != "meta") {
        codecs[translateCodec(AwmVideo.info.meta.tracks[i])] = AwmVideo.info.meta.tracks[i].codec;
      }
    }
    var container = mimetype.split("/")[2];

    function test(codecs) {
      //if (container == "webm") { return true; }
      return MediaSource.isTypeSupported("video/" + container + ";codecs=\"" + codecs + "\"");
    }

    source.supportedCodecs = [];
    for (var i in codecs) {
      //i is the long name (like mp4a.40.2), codecs[i] is the short name (like AAC)
      var s = test(i);
      if (s) {
        source.supportedCodecs.push(codecs[i]);
      }
    }
    if ((!AwmVideo.options.forceType) && (!AwmVideo.options.forcePlayer)) { //unless we force mews, skip this players if not both video and audio are supported
      if (source.supportedCodecs.length < source.simul_tracks) {
        AwmVideo.log("Not enough playable tracks for this source");
        return false;
      }
    }
    return source.supportedCodecs.length > 0;
  },
  player: function () {
  }
};
var p = awmplayers.mews.player;
p.prototype = new AwmPlayer();
p.prototype.build = function (AwmVideo, callback) {

  var video = document.createElement("video");
  video.setAttribute("playsinline", ""); //iphones. effin' iphones.

  //apply options
  var attrs = ["autoplay", "loop", "poster"];
  for (var i in attrs) {
    var attr = attrs[i];
    if (AwmVideo.options[attr]) {
      video.setAttribute(attr, (AwmVideo.options[attr] === true ? "" : AwmVideo.options[attr]));
    }
  }
  if (AwmVideo.options.muted) {
    video.muted = true; //don't use attribute because of Chrome bug
  }
  if (AwmVideo.info.type == "live") {
    video.loop = false;
  }
  if (AwmVideo.options.controls == "stock") {
    video.setAttribute("controls", "");
  }
  video.setAttribute("crossorigin", "anonymous");
  this.setSize = function (size) {
    video.style.width = size.width + "px";
    video.style.height = size.height + "px";
  };

  var player = this;
  player.name = "mews";
  //player.debugging = true;

  //this function is called both when the websocket is ready and the media source is ready - both should be open to proceed
  function checkReady() {
    if ((player.ws.readyState == player.ws.OPEN) && (player.ms.readyState == "open") && (player.sb)) {
      callback(video);
      if (AwmVideo.options.autoplay) {
        player.api.play();
      }
      return true;
    }
  }

  this.msinit = function () {
    return new Promise(function (resolve) {
      //prepare mediasource
      player.ms = new MediaSource();
      video.src = URL.createObjectURL(player.ms);
      player.ms.onsourceopen = function () {
        resolve();
      };
      player.ms.onsourceclose = function (e) {
        console.error("ms close", e);
        send({type: "stop"}); //stop sending data please something went wrong
      };
      player.ms.onsourceended = function (e) {
        console.error("ms ended", e);

        //for debugging

        function downloadBlob(data, fileName, mimeType) {
          var blob, url;
          blob = new Blob([data], {
            type: mimeType
          });
          url = window.URL.createObjectURL(blob);
          downloadURL(url, fileName);
          setTimeout(function () {
            return window.URL.revokeObjectURL(url);
          }, 1000);
        }

        function downloadURL(data, fileName) {
          var a;
          a = document.createElement('a');
          a.href = data;
          a.download = fileName;
          document.body.appendChild(a);
          a.style = 'display: none';
          a.click();
          a.remove();
        }

        if (player.debugging) {
          var l = 0;
          for (var i = 0; i < player.sb.appended.length; i++) {
            l += player.sb.appended[i].length;
          }
          var d = new Uint8Array(l);
          l = 0;
          for (var i = 0; i < player.sb.appended.length; i++) {
            d.set(player.sb.appended[i], l);
            l += player.sb.appended[i].length;
          }

          downloadBlob(d, 'appended.mp4.bin', 'application/octet-stream');
        }
        send({type: "stop"}); //stop sending data please something went wrong
      };
    });
  }
  this.msinit().then(function () {
    if (player.sb) {
      AwmVideo.log("Not creating source buffer as one already exists.");
      return;
    }
    checkReady();
  });
  this.onsbinit = [];
  this.sbinit = function (codecs) {
    if (!codecs) {
      AwmVideo.showError("Did not receive any codec: nothing to initialize.");
      return;
    }

    //console.log("sourcebuffers",player.ms.sourceBuffers.length);
    //console.log("sb init","video/"+AwmVideo.source.type.split("/")[2]+";codecs=\""+codecs.join(",")+"\"");
    player.sb = player.ms.addSourceBuffer("video/" + AwmVideo.source.type.split("/")[2] + ";codecs=\"" + codecs.join(",") + "\"");
    player.sb.mode = "segments"; //the fragments will be put in the buffer at the correct time: much better behavior when seeking / not playing from 0s

    //save the current source buffer codecs
    player.sb._codecs = codecs;

    player.sb._duration = 1;
    player.sb._size = 0;
    player.sb.queue = [];
    var do_on_updateend = [];
    player.sb.do_on_updateend = do_on_updateend; //so we can check it from the ws onmessage handler too
    player.sb.appending = null;
    player.sb.appended = [];
    var n = 0;
    player.sb.addEventListener("updateend", function () {
      if (!player.sb) {
        AwmVideo.log("Reached updateend but the source buffer is " + JSON.stringify(player.sb) + ". ");
        return;
      }
      //player.sb._busy = true;
      //console.log("start updateend");

      if (player.debugging) {
        if (player.sb.appending) player.sb.appended.push(player.sb.appending);
        player.sb.appending = null;
      }

      //every 500 fragments, clean the buffer (about every 15 sec)
      if (n >= 500) {
        //console.log(n,video.currentTime - video.buffered.start(0));
        n = 0;
        player.sb._clean(10); //keep 10 sec
      } else {
        n++;
      }

      var do_funcs = do_on_updateend.slice(); //clone the array
      do_on_updateend = [];
      for (var i in do_funcs) {
        //console.log("do_funcs",Number(i)+1,"/",do_funcs.length);
        if (!player.sb) {
          if (player.debugging) {
            console.warn("I was doing on_updateend but the sb was reset");
          }
          break;
        }
        if (player.sb.updating) {
          //it's updating again >_>
          do_on_updateend.concat(do_funcs.slice(i)); //add the remaining functions to do_on_updateend
          if (player.debugging) {
            console.warn("I was doing on_updateend but was interrupted");
          }
          break;
        }
        do_funcs[i](i < do_funcs.length - 1 ? do_funcs.slice(i) : []); //pass remaining do_funcs as argument
      }

      if (!player.sb) {
        return;
      }

      player.sb._busy = false;
      //console.log("end udpateend");
      //console.log("onupdateend",player.sb.queue.length,player.sb.updating);
      if (player.sb && player.sb.queue.length > 0 && !player.sb.updating && !video.error) {
        //console.log("appending from queue");
        player.sb._append(this.queue.shift());
      }
    });
    player.sb.error = function (e) {
      console.error("sb error", e);
    };
    player.sb.abort = function (e) {
      console.error("sb abort", e);
    };

    player.sb._doNext = function (func) {
      do_on_updateend.push(func);
    };
    player.sb._do = function (func) {
      if (this.updating || this._busy) {
        this._doNext(func);
      } else {
        func();
      }
    }
    player.sb._append = function (data) {
      if (!data) {
        return;
      }
      if (!data.buffer) {
        return;
      }
      if (player.debugging) {
        player.sb.appending = new Uint8Array(data);
      }
      if (player.sb._busy) {
        if (player.debugging) console.warn("I wanted to append data, but now I won't because the thingy was still busy. Putting it back in the queue.");
        player.sb.queue.unshift(data);
        return;
      }
      player.sb._busy = true;
      //console.log("appendBuffer");
      player.sb.appendBuffer(data);
    }

    //we're initing the source buffer and there is a msg queue of data built up before the buffer was ready. Start by adding these data fragments to the source buffer
    if (player.msgqueue) {
      //There may be more than one msg queue, i.e. when rapidly switching tracks. Add only one msg queue and always add the oldest msg queue first.
      if (player.msgqueue[0]) {
        var do_do = false; //if there are no messages in the queue, make sure to execute any do_on_updateend functions right away
        if (player.msgqueue[0].length) {
          for (var i in player.msgqueue[0]) {
            if (player.sb.updating || player.sb.queue.length || player.sb._busy) {
              player.sb.queue.push(player.msgqueue[0][i]);
            } else {
              //console.log("appending new data");
              player.sb._append(player.msgqueue[0][i]);
            }
          }
        } else {
          do_do = true;
        }
        player.msgqueue.shift();
        if (player.msgqueue.length == 0) {
          player.msgqueue = false;
        }
        AwmVideo.log("The newly initialized source buffer was filled with data from a seperate message queue." + (player.msgqueue ? " " + player.msgqueue.length + " more message queue(s) remain." : ""));
        if (do_do) {
          AwmVideo.log("The seperate message queue was empty; manually triggering any onupdateend functions");
          player.sb.dispatchEvent(new Event("updateend"));
        }
      }
    }

    //remove everything keepaway secs before the current playback position to keep sourcebuffer from filling up
    player.sb._clean = function (keepaway) {
      if (!keepaway) keepaway = 180;
      if (video.currentTime > keepaway) {
        player.sb._do(function () {
          //make sure end time is never 0
          player.sb.remove(0, Math.max(0.1, video.currentTime - keepaway));
        });
      }
    }

    if (player.onsbinit.length) {
      player.onsbinit.shift()();
    }
    //console.log("sb inited");
  };

  this.wsconnect = function () {
    return new Promise(function (resolve) {
      //prepare websocket (both data and messages)
      this.ws = new WebSocket(AwmVideo.source.url);
      this.ws.binaryType = "arraybuffer";

      this.ws.onopen = function () {
        resolve();
      };
      this.ws.onerror = function () {
        AwmVideo.showError("MP4 over WS: websocket error");
      }
      this.ws.onclose = function () {
        AwmVideo.log("MP4 over WS: websocket closed");
      };
      this.ws.listeners = {}; //kind of event listener list for websocket messages
      this.ws.addListener = function (type, f) {
        if (!(type in this.listeners)) {
          this.listeners[type] = [];
        }
        this.listeners[type].push(f);
      };
      this.ws.removeListener = function (type, f) {
        if (!(type in this.listeners)) {
          return;
        }
        var i = this.listeners[type].indexOf(f);
        if (i < 0) {
          return;
        }
        this.listeners[type].splice(i, 1);
        return true;
      }
      player.msgqueue = false;
      var requested_rate = 1;
      this.ws.onmessage = function (e) {
        if (!e.data) {
          throw "Received invalid data";
        }
        if (typeof e.data == "string") {
          var msg = JSON.parse(e.data);
          if (player.debugging && (msg.type != "on_time")) {
            console.log("ws message", msg);
          }
          switch (msg.type) {
            case "on_stop": {
              //the last fragment has been added to the buffer
              var eObj;
              eObj = AwmUtil.event.addListener(video, "waiting", function () {
                AwmUtil.event.send("ended", null, video);
                AwmUtil.event.removeListener(eObj);
              });

              break;
            }
            case "on_time": {
              var buffer = msg.data.current - video.currentTime * 1e3;
              var serverDelay = player.ws.serverDelay.get();
              var desiredBuffer = Math.max(500 + serverDelay, serverDelay * 2);
              if (AwmVideo.info.type != "live") {
                desiredBuffer += 2000;
              } //if VoD, keep an extra 2 seconds of buffer
              if (player.debugging) console.log("on_time received", msg.data.current / 1e3, "currtime", video.currentTime, requested_rate + "x", "buffer", Math.round(buffer), "/", Math.round(desiredBuffer), (AwmVideo.info.type == "live" ? "latency:" + Math.round(msg.data.end - video.currentTime * 1e3) + "ms" : ""), "listeners", player.ws.listeners && player.ws.listeners.on_time ? player.ws.listeners.on_time : 0, "msgqueue", player.msgqueue ? player.msgqueue.length : 0, msg.data);

              if (!player.sb) {
                AwmVideo.log("Received on_time, but the source buffer is being cleared right now. Ignoring.");
                break;
              }

              if (player.sb._duration != msg.data.end * 1e-3) {
                player.sb._duration = msg.data.end * 1e-3;
                AwmUtil.event.send("durationchange", null, AwmVideo.video);
              }
              AwmVideo.info.meta.buffer_window = msg.data.end - msg.data.begin;
              player.sb.paused = false;

              if (AwmVideo.info.type == "live") {
                if (requested_rate == 1) {
                  if (msg.data.play_rate_curr == "auto") {
                    if (video.currentTime > 0) { //give it some time to seek to live first when starting up
                      //assume we want to be as live as possible
                      if (buffer - desiredBuffer > desiredBuffer) {
                        requested_rate = 1.1 + Math.min(1, ((buffer - desiredBuffer) / desiredBuffer)) * 0.15;
                        video.playbackRate *= requested_rate;
                        AwmVideo.log("Our buffer is big, so increase the playback speed to catch up.");
                      } else if (buffer < desiredBuffer / 2) {
                        requested_rate = 0.9;
                        video.playbackRate *= requested_rate;
                        AwmVideo.log("Our buffer is small, so decrease the playback speed to catch up.");
                      }
                    }
                  }
                } else if (requested_rate > 1) {
                  if (buffer < desiredBuffer) {
                    video.playbackRate /= requested_rate;
                    requested_rate = 1;
                    AwmVideo.log("Our buffer is small enough, so return to real time playback.");
                  }
                } else {
                  //requested rate < 1
                  if (buffer > desiredBuffer) {
                    video.playbackRate /= requested_rate;
                    requested_rate = 1;
                    AwmVideo.log("Our buffer is big enough, so return to real time playback.");
                  }
                }
              } else {
                //it's VoD, change the rate at which the server sends data to try and keep the buffer small
                if (requested_rate == 1) {
                  if (msg.data.play_rate_curr == "auto") {
                    if (buffer < desiredBuffer / 2) {
                      if (buffer < -10e3) {
                        //seek to play point
                        send({type: "seek", seek_time: video.currentTime * 1e3});
                      } else {
                        //negative buffer? ask for faster delivery
                        requested_rate = 2;
                        AwmVideo.log("Our buffer is negative, so request a faster download rate.");
                        send({type: "set_speed", play_rate: requested_rate});
                      }
                    } else if (buffer - desiredBuffer > desiredBuffer) {
                      AwmVideo.log("Our buffer is big, so request a slower download rate.");
                      requested_rate = 0.5;
                      send({type: "set_speed", play_rate: requested_rate});
                    }
                  }
                } else if (requested_rate > 1) {
                  if (buffer > desiredBuffer) {
                    //we have enough buffer, ask for real time delivery
                    send({type: "set_speed", play_rate: "auto"});
                    requested_rate = 1;
                    AwmVideo.log("The buffer is big enough, so ask for realtime download rate.");
                  }
                } else { //requested_rate < 1
                  if (buffer < desiredBuffer) {
                    //we have a small enough bugger, ask for real time delivery
                    send({type: "set_speed", play_rate: "auto"});
                    requested_rate = 1;
                    AwmVideo.log("The buffer is small enough, so ask for realtime download rate.");
                  }
                }
              }
              break;
            }
            case "tracks": {
              //check if all codecs are equal to the ones we were using before
              function checkEqual(arr1, arr2) {
                if (!arr2) {
                  return false;
                }
                if (arr1.length != arr2.length) {
                  return false;
                }
                for (var i in arr1) {
                  if (arr2.indexOf(arr1[i]) < 0) {
                    return false;
                  }
                }
                return true;
              }


              if (checkEqual(player.last_codecs ? player.last_codecs : player.sb._codecs, msg.data.codecs)) {
                if (player.debugging) console.log("reached switching point");
                if (msg.data.current > 0) {
                  if (player.sb) { //if sb is being cleared at the moment, don't bother
                    player.sb._do(function () { //once the source buffer is done updating the current segment, clear the specified interval from the buffer
                      player.sb.remove(0, msg.data.current * 1e-3);
                    });
                  }
                }

                AwmVideo.log("Player switched tracks, keeping source buffer as codecs are the same as before.");
              } else {
                if (player.debugging) {
                  console.warn("Different codecs!");
                  console.warn("video time", video.currentTime, "waiting until", msg.data.current * 1e-3);
                }
                player.last_codecs = msg.data.codecs;
                //start gathering messages in a new msg queue. They won't be appended to the current source buffer
                if (player.msgqueue) {
                  player.msgqueue.push([]);
                } else {
                  player.msgqueue = [[]];
                }
                //play out buffer, then when we reach the starting timestamp of the new data, reset the source buffers
                var clear = function () {
                  //once the source buffer is done updating the current segment, clear the specified interval from the buffer
                  if (player && player.sb) {
                    player.sb._do(function (remaining_do_on_updateend) {
                      if (!player.sb.updating) {
                        if (!isNaN(player.ms.duration)) player.sb.remove(0, Infinity);
                        player.sb.queue = [];
                        player.ms.removeSourceBuffer(player.sb);
                        player.sb = null;
                        var t = (msg.data.current * 1e-3).toFixed(3); //rounded because of floating point issues
                        video.src = "";
                        player.ms.onsourceclose = null;
                        player.ms.onsourceended = null;
                        //console.log("sb murdered");
                        if (player.debugging && remaining_do_on_updateend && remaining_do_on_updateend.length) {
                          console.warn("There are do_on_updateend functions queued, which I *should* re-apply after clearing the sb.");
                        }

                        player.msinit().then(function () {
                          player.sbinit(msg.data.codecs);
                          player.sb.do_on_updateend = remaining_do_on_updateend;

                          var e = AwmUtil.event.addListener(video, "loadedmetadata", function () {
                            AwmVideo.log("Buffer cleared, setting playback position to " + AwmUtil.format.time(t, {ms: true}));

                            var f = function () {
                              video.currentTime = t;
                              if (video.currentTime < t) {
                                player.sb._doNext(f);
                                if (player.debugging) {
                                  console.log("Could not set playback position");
                                }
                              } else {
                                if (player.debugging) {
                                  console.log("Set playback position to " + AwmUtil.format.time(t, {ms: true}));
                                }
                                var p = function () {
                                  player.sb._doNext(function () {
                                    if (video.buffered.length) {
                                      if (player.debugging) {
                                        console.log(video.buffered.start(0), video.buffered.end(0), video.currentTime);
                                      }
                                      if (video.buffered.start(0) > video.currentTime) {
                                        var b = video.buffered.start(0);
                                        video.currentTime = b;
                                        if (video.currentTime != b) {
                                          p();
                                        }
                                      }
                                    } else {
                                      p();
                                    }
                                  });
                                };
                                p();
                              }
                            }
                            f();

                            AwmUtil.event.removeListener(e);
                          });
                        });
                      } else {
                        clear();
                      }
                    });
                  } else {
                    if (player.debugging) {
                      console.warn("sb not available to do clear");
                    }
                    player.onsbinit.push(clear);
                  }
                };

                if (!msg.data.codecs || !msg.data.codecs.length) {
                  AwmVideo.showError("Track switch does not contain any codecs, aborting.");
                  //reset setTracks to auto
                  AwmVideo.options.setTracks = false;
                  clear();
                  break;
                }

                if (player.debugging) {
                  console.warn("reached switching point", msg.data.current * 1e-3, AwmUtil.format.time(msg.data.current * 1e-3));
                }
                clear();

              }

              if (msg.data.codecs && msg.data.codecs.length) {
                AwmUtil.event.send("playerUpdate_trackChanged", {
                  codecsId: msg.data.codecs,
                  tracksId: msg.data.tracks
                }, AwmVideo.video);
              }
            }
          }
          if (msg.type in this.listeners) {
            for (var i = this.listeners[msg.type].length - 1; i >= 0; i--) { //start at last in case the listeners remove themselves
              this.listeners[msg.type][i](msg);
            }
          }
          return;
        }
        var data = new Uint8Array(e.data);
        if (data) {
          if ((player.sb) && (!player.msgqueue)) {
            if (player.sb.updating || player.sb.queue.length || player.sb._busy) {
              player.sb.queue.push(data);
            } else {
              //console.log("appending new data");
              player.sb._append(data);
            }
          } else {
            //There is no active source buffer or we're preparing for a track switch.
            //Any data is kept in a seperate buffer and won't be appended to the source buffer until it is reinitialised.
            if (!player.msgqueue) {
              player.msgqueue = [[]];
            }
            //There may be more than one seperate buffer (in case of rapid track switches), always append to the last of the buffers
            player.msgqueue[player.msgqueue.length - 1].push(data);
          }
        } else {
          //console.warn("no data, wut?",data,new Uint8Array(e.data));
          AwmVideo.log("Expecting data from websocket, but received none?!");
        }
      }


      this.ws.serverDelay = {
        delays: [],
        log: function (type) {
          var responseType = false;
          switch (type) {
            case "seek":
            case "set_speed": {
              //wait for cmd.type
              responseType = type;
              break;
            }
            case "request_codec_data": {
              responseType = "codec_data";
              break;
            }
            default: {
              //do nothing
              return;
            }
          }
          if (responseType) {
            var starttime = new Date().getTime();

            function onResponse() {
              player.ws.serverDelay.add(new Date().getTime() - starttime);
              player.ws.removeListener(responseType, onResponse);
            }

            player.ws.addListener(responseType, onResponse);
          }
        },
        add: function (delay) {
          this.delays.unshift(delay);
          if (this.delays.length > 5) {
            this.delays.splice(5);
          }
        },
        get: function () {
          if (this.delays.length) {
            //return average of the last 3 recorded delays
            let sum = 0;
            let i = 0;
            for (null; i < this.delays.length; i++) {
              if (i >= 3) {
                break;
              }
              sum += this.delays[i];
            }
            return sum / i;
          }
          return 500;
        }
      };
    }.bind(this));
  };
  this.wsconnect().then(function () {
    //retrieve codec info
    var f = function (msg) {
      //got codec data, set up source buffer

      player.sbinit(msg.data.codecs);

      checkReady();
      player.ws.removeListener("codec_data", f);
    };
    this.ws.addListener("codec_data", f);
    send({type: "request_codec_data", supported_codecs: AwmVideo.source.supportedCodecs});
  }.bind(this));

  function send(cmd) {
    if (!player.ws) {
      throw "No websocket to send to";
    }
    if (player.ws.readyState >= player.ws.CLOSING) {
      //throw "WebSocket has been closed already.";
      player.wsconnect().then(function () {
        send(cmd);
      });
      return;
    }
    if (player.debugging) {
      console.log("ws send", cmd);
    }

    player.ws.serverDelay.log(cmd.type);
    player.ws.send(JSON.stringify(cmd));
  }

  player.findBuffer = function (position) {
    var buffern = false;
    for (var i = 0; i < video.buffered.length; i++) {
      if ((video.buffered.start(i) <= position) && (video.buffered.end(i) >= position)) {
        buffern = i;
        break;
      }
    }
    return buffern;
  };

  this.api = {
    play: function (skipToLive) {
      return new Promise(function (resolve, reject) {
        var f = function (e) {
          if (!player.sb) {
            AwmVideo.log("Attempting to play, but the source buffer is being cleared. Waiting for next on_time.");
            return;
          }
          if (AwmVideo.info.type == "live") {
            if (skipToLive || (video.currentTime == 0)) {
              var g = function () {
                if (video.buffered.length) {
                  //is data.current contained within a buffer? is video.currentTime also contained in that buffer? if not, seek the video
                  var buffern = player.findBuffer(e.data.current * 1e-3);
                  if (buffern !== false) {
                    if ((video.buffered.start(buffern) > video.currentTime) || (video.buffered.end(buffern) < video.currentTime)) {
                      video.currentTime = e.data.current * 1e-3;
                      AwmVideo.log("Setting live playback position to " + AwmUtil.format.time(video.currentTime));
                    }
                    video.play().then(resolve).catch(reject);
                    player.sb.paused = false;
                    player.sb.removeEventListener("updateend", g);
                  }
                }
              };
              player.sb.addEventListener("updateend", g);
            } else {
              player.sb.paused = false;
              video.play().then(resolve).catch(reject);
            }
            player.ws.removeListener("on_time", f);
          } else if (e.data.current > video.currentTime) {
            player.sb.paused = false;
            video.play().then(resolve).catch(reject);
            player.ws.removeListener("on_time", f);
          }
        };
        player.ws.addListener("on_time", f);

        var cmd = {type: "play"};
        if (skipToLive) {
          cmd.seek_time = "live";
        }
        send(cmd);
      });
    },
    pause: function () {
      video.pause();
      send({type: "hold",});
      if (player.sb) {
        player.sb.paused = true;
      }
    },
    setTracks: function (obj) {
      obj.type = "tracks";
      obj = AwmUtil.object.extend({
        type: "tracks",
        audio: null,
        video: null,
        seek_time: Math.max(0, video.currentTime * 1e3 - (500 + player.ws.serverDelay.get()))
      }, obj);
      send(obj);
    },
    unload: function () {
      player.api.pause();
      player.sb._do(function () {
        player.sb.remove(0, Infinity);
        try {
          player.ms.endOfStream();

          //it's okay if it fails
        } catch (e) {
        }
      });
      player.ws.close();
      delete window.awmMewsOnVisibilityChange;
      document.removeEventListener("visibilitychange", onVisibilityChange);
    }
  };

  //override seeking
  Object.defineProperty(this.api, "currentTime", {
    get: function () {
      return video.currentTime;
    },
    set: function (value) {
      AwmUtil.event.send("seeking", value, video);
      send({type: "seek", seek_time: Math.max(0, value * 1e3 - (250 + player.ws.serverDelay.get()))}); //safety margin for server latency
      //set listener "seek"
      var onseek = function () {
        player.ws.removeListener("seek", onseek);
        var ontime = function (e) {
          player.ws.removeListener("on_time", ontime);
          //in the first on_time, assume that the data were getting is where we want to be
          value = (e.data.current * 1e-3).toFixed(3);
          var f = function () {
            video.currentTime = value;
            if (video.currentTime != value) {
              if (player.debugging) console.log("Failed to set video.currentTime, wanted:", value, "got:", video.currentTime);
              player.sb._doNext(f);
            }
          }
          f();
        };
        player.ws.addListener("on_time", ontime);
      }
      player.ws.addListener("seek", onseek);
      video.currentTime = value;
      AwmVideo.log("Seeking to " + AwmUtil.format.time(value, {ms: true}) + " (" + value + ")");
    }
  });
  //override duration
  Object.defineProperty(this.api, "duration", {
    get: function () {
      return player.sb ? player.sb._duration : 1;
    }
  });
  Object.defineProperty(this.api, "playbackRate", {
    get: function () {
      return video.playbackRate;
    },
    set: function (value) {
      var f = function (msg) {
        video.playbackRate = msg.data.play_rate;
      };
      player.ws.addListener("set_speed", f);
      send({type: "set_speed", play_rate: (value == 1 ? "auto" : value)});
    }
  });

  //redirect properties
  //using a function to make sure the "item" is in the correct scope
  function reroute(item) {
    Object.defineProperty(player.api, item, {
      get: function () {
        return video[item];
      },
      set: function (value) {
        return video[item] = value;
      }
    });
  }

  var list = [
    "volume",
    "buffered",
    "muted",
    "loop",
    "paused",
    "error",
    "textTracks",
    "webkitDroppedFrameCount",
    "webkitDecodedFrameCount"
  ];
  for (var i in list) {
    reroute(list[i]);
  }

  //loop
  AwmUtil.event.addListener(video, "ended", function () {
    if (player.api.loop) {
      player.api.currentTime = 0;
      player.sb._do(function () {
        player.sb.remove(0, Infinity);
      });
    }
  });
  //pause if tab is hidden to prevent buildup of frames
  var autopaused = false;

  //only add this once!
  function onVisibilityChange() {
    if (document.hidden) {
      //check if we are playing (not video.paused! that already returns true)
      if (!player.sb.paused) {
        player.api.pause();
        autopaused = true;
        if (AwmVideo.info.type == "live") {
          autopaused = "live"; //go to live point
          //NB: even if the player wasn't near the live point when it was paused, we've likely exited the buffer while we were paused, so the current position probably won't exist anymore. Just skip to live.
        }
        AwmVideo.log("Pausing the player as the tab is inactive.");
      }
    } else if (autopaused) {
      player.api.play(autopaused == "live");
      autopaused = false;
      AwmVideo.log("Restarting the player as the tab is now active again.");
    }
  }

  if (!window.awmMewsOnVisibilityChange) {
    window.awmMewsOnVisibilityChange = true;
    document.addEventListener("visibilitychange", onVisibilityChange);
  }

  var seeking = false;
  AwmUtil.event.addListener(video, "seeking", function () {
    seeking = true;
    var seeked = AwmUtil.event.addListener(video, "seeked", function () {
      seeking = false;
      AwmUtil.event.removeListener(seeked);
    });
  });
  AwmUtil.event.addListener(video, "waiting", function () {
    //check if there is a gap in the buffers, and if so, jump it
    if (seeking) {
      return;
    }
    var buffern = player.findBuffer(video.currentTime);
    if (buffern !== false) {
      if ((buffern + 1 < video.buffered.length) && (video.buffered.start(buffern + 1) - video.currentTime < 10e3)) {
        AwmVideo.log("Skipped over buffer gap (from " + AwmUtil.format.time(video.currentTime) + " to " + AwmUtil.format.time(video.buffered.start(buffern + 1)) + ")");
        video.currentTime = video.buffered.start(buffern + 1);
      }
    }
  });

  if (player.debugging) {
    AwmUtil.event.addListener(video, "waiting", function () {
      //check the buffer available
      var buffers = [];
      var contained = false;
      for (var i = 0; i < video.buffered.length; i++) {
        if ((video.currentTime >= video.buffered.start(i)) && (video.currentTime <= video.buffered.end(i))) {
          contained = true;
        }
        buffers.push([
          video.buffered.start(i),
          video.buffered.end(i),
        ]);
      }
      console.log("waiting", "currentTime", video.currentTime, "buffers", buffers, contained ? "contained" : "outside of buffer", "readystate", video.readyState, "networkstate", video.networkState);
      if ((video.readyState >= 2) && (video.networkState >= 2)) {
        console.error("Why am I waiting?!");
      }

    });
  }
};
