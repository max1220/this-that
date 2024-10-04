"use strict";

function ThisThat() {
	let last_id = localStorage.getItem("this_that_last_peer_id")
	this.self_peer = new Peer(last_id)
	this.connections = new Map()
	this.calls = new Map()
	this.self_stream = {}
	this.callbacks = {}
	this.crypto_lib = new CryptoLib()
	
	// storage for own profile
	this.self_profile_storage = new SyncedLocalStorageObject("this_that_self_profile")

	// trigger a callback function if present
	let trigger_callback = (name, arg) => {
		if (!this.callbacks[name]) { return; }
		return this.callbacks[name](arg)
	}

	// create a signed profile update envelope and send it to con
	this.send_profile_update = async (con) => {
		let profile_update_envelope = await this.crypto_lib.sign_envelope(this.self_profile_storage.data)
		console.log("sending profile_update_envelope to", con.peer, profile_update_envelope)
		con.send({
			command: "profile_update",
			arg: profile_update_envelope
		})
	}

	// get the list of all known profiles in the localStorage
	this.get_profile_keys = () => {
		let profile_keys = []
		for (let i=0; i<localStorage.length; i++) {
			let key = localStorage.key(i)
			if (key.startsWith("this_that_profile_")) {
				profile_keys.push(key)
			}
		}
		return profile_keys
	}

	this.has_profile_storage = (public_key_hash) => localStorage.hasOwnProperty("this_that_profile_"+public_key_hash)

	// get or create the localStorage wrapper for a profile based on it's public key hash
	this.get_profile_storage = (public_key_hash, on_update) => {
		let profile_storage = new SyncedLocalStorageObject("this_that_profile_"+public_key_hash, on_update)
		if (!profile_storage.data) {
			profile_storage.update({
				public_key_hash: public_key_hash,
				first_seen: new Date().toISOString(),
				chat_history: [],
			})
		}
		return profile_storage
	}

	// handle an incoming profile update
	this.handle_profile_update = async (con, profile_update_envelope) => {
		let inner_json = await this.crypto_lib.verify_envelope(profile_update_envelope, 5000)
		if (!inner_json) { console.error("Profile update could not be verified!"); return; }
		if (inner_json.profile_data.peer_id !== con.peer) { console.error("Peer ID mismatch!", con.peer, inner_json.profile_data); return; }
		let profile_storage = this.get_profile_storage(inner_json.public_key_hash)
		profile_storage.data.profile_data = inner_json.profile_data
		profile_storage.data.last_seen = new Date().toISOString()
		profile_storage.update()
		con.profile = profile_storage
		console.log("handle_profile_update", profile_storage)
		trigger_callback("profile_update", profile_storage)
	}

	// send a message to the specified peer_id
	this.send_to_peer = (peer_id, data) => this.connect_peer(peer_id, (con) => {
		console.log("sending to",peer_id,":",data)
		con.send(data)
	})

	// send a chat message to a peer
	this.send_chat_message = (public_key_hash, message) => {
		// get profile for public_key_hash
		if (!public_key_hash) { console.error("Need public_key_hash!"); return; }
		if (!this.has_profile_storage(public_key_hash)) { console.error("No profile!"); return; }
		let profile = this.get_profile_storage(public_key_hash)

		// add chat message to message history
		profile.data.chat_history.push({ from: "self", time: new Date().toISOString(), arg: message })
		profile.update()

		// send message to peer
		this.send_to_peer(profile.data.profile_data.peer_id, {
			command: "chat_message",
			arg: message
		})
	}

	// handle a chat message from a user
	this.handle_chat_message = (con, data) => {
		let now = new Date().toISOString()
		con.profile.data.chat_history.push({ from: con.profile.public_key_hash, time: now, arg: data })
		con.profile.update()
		trigger_callback("chat_message", { from: con, time: now, arg: data})
	}

	// handle data from a connection
	this.handle_data = async (con, data) => {
		if (!con.profile && (data.command == "profile_update")) {
			// only allow profile_update command until at least one has been received
			// sending a valid profile update also serves as authentication for this connection
			await this.handle_profile_update(con, data.arg)
		} else if (con.profile) {
			if (trigger_callback("connection_data", { con: con, data: data })) {
				// callback handled data	
			} else if (data.command == "chat_message") {
				this.handle_chat_message(con, data.arg)
			} else if (data.command == "profile_update") {
				// profile update from already authenticated user
				await this.handle_profile_update(con, data.arg)
			} else {
				console.warn("Unknown message from authenticated peer: ", con, data)
			}
		} else {
			console.error("Unknown message from unauthenticated peer: ", con, data)
			con.close()
		}
	}




	// request the own audio/video/screen stream
	this.request_self_stream = (stream_type, stream_cb) => {
		stream_cb = stream_cb ? stream_cb : () => {}
		if (this.self_stream[stream_type]) { stream_cb(this.self_stream[stream_type]); }
		let remove_stream = () => {
			if (!this.self_stream[stream_type]) { return; }
			console.log("request_self_stream: remove_stream", stream_type, this.self_stream[stream_type])
			this.self_stream[stream_type] = undefined
			trigger_callback("self_stream_removed", { stream_type: stream_type })
		}
		let handle_stream = (stream) => {
			console.log("request_self_stream: got stream", stream_type, stream)
			this.self_stream[stream_type] = stream
			// disable audio if user is currently muted
			if (this.muted) { this.mute_self_streams(); }
			stream_cb(stream)
			stream.getTracks().forEach((track) => { track.onended = remove_stream; })
			trigger_callback("self_stream_added", { stream_type: stream_type, stream: stream })
		}
		console.log("request_self_stream", stream_type)
		if (stream_type == "audio") {
			navigator.mediaDevices.getUserMedia({audio: true}).then(handle_stream).catch(remove_stream)
		} else if (stream_type == "video") {
			navigator.mediaDevices.getUserMedia({audio: true, video: true}).then(handle_stream).catch(remove_stream)
		} else if (stream_type == "screen") {
			// merge screen stream with system audio and user(microphone) audio
			navigator.mediaDevices.getDisplayMedia({video: true, audio: true, systemAudio: "include"}).then((screen_stream) => {
				navigator.mediaDevices.getUserMedia({audio: true}).then((audio_stream) => {
					let merged_stream = new MediaStream([...screen_stream.getTracks(), ...audio_stream.getTracks()])
					handle_stream(merged_stream)
				}).catch(remove_stream)
			}).catch(remove_stream)
		} else {
			console.error("Invalid stream_type:",stream_type)
		}
	}

	// connect to a remote peer for status updates and chat messages
	this.connect_peer = (peer_id, open_cb) => {
		if (this.connections.has(peer_id)) { console.warn("Already has connection with peer!"); return; }
		this.crypto_lib.sign_envelope(this.self_profile_storage.data).then((profile_update_envelope) => {
			console.log("Connecting to peer", peer_id, "signed:", profile_update_envelope)
			this.add_connection(this.self_peer.connect(peer_id, { metadata: profile_update_envelope }), open_cb)
		})
		return 
	}

	// initiate a new call with a peer
	this.call_peer = (peer_id, stream_type) => {
		if (this.calls.has(peer_id)) { console.warn("Already has a call with peer!"); return; }
		this.request_self_stream(stream_type, (self_stream) => {
			this.crypto_lib.sign_envelope(this.self_profile_storage.data).then((profile_update_envelope) => {
				console.log("Calling peer", peer_id, "using stream:", stream_type, self_stream, "signed:", profile_update_envelope)
				let call = this.self_peer.call(peer_id, self_stream, { metadata: profile_update_envelope })
				call.self_stream = self_stream
				this.add_call(call)		
			})
		})
	}

	// add a new connection to the list of active connections
	this.add_connection = (con, open_cb, profile_update_envelope) => {
		if (this.connections.has(con.peer)) { con.close(); return this.connections.get(con.peer); }
		this.connections.set(con.peer, con)

		// hack because we need to wait for a promise
		con.data_ready = true
		con.data_buf = []

		con.on("data", (data) => {
			if (con.data_ready) {
				let recursive_handle_data = () => {
					if (con.data_buf.length > 0) {
						let buf = con.data_buf.shift()
						this.handle_data(con, buf).then(recursive_handle_data)
					} else {
						con.data_ready = true
					}
				}
				con.data_ready = false
				recursive_handle_data()
			} else {
				// add to list of outstanding data buffers to handle
				console.log("Queuing data",data)
				con.data_buf.push(data)
			}


			// hack needed because this function isn't used in an async way(can't process items out-of-order, handle_data is async)
			
			if (con.data_ready) {
				con.data_ready = false
				// handle data asynchronously, so when new data arives while handle_data is still processing(unresolved),
				// the new data is processed in-order instead of immediately.
				this.handle_data(con, data).then(() => {
					
					for (let i=0; i<con.data_buf.length; i++) {
						console.log("handle buffered data", con.data_buf[i])
						this.handle_data(con, con.data_buf[i])
					}
					con.data_buf.length = 0
					con.data_ready = true
				})
			} else {
				
				
			}
		})
		con.on("close", () => {
			this.connections.delete(con.peer)
			trigger_callback("connection_close", con)
		})
		con.on("open", () => {
			this.send_profile_update(con).then(() => {
				if (open_cb) { open_cb(con) }
			})
		})
		if (con._open) {
			this.send_profile_update(con).then(() => {
				if (open_cb) { open_cb(con) }
			})
		}
		trigger_callback("connection", con)
		return con
	}

	// add a call to the list of active calls
	this.add_call = (call) => {
		if (this.calls.has(this.calls.peer)) { call.close(); return this.calls.get(call.peer); }
		this.calls.set(call.peer, call)
		console.log("add_call", call)

		// handle an incoming remote stream
		call.on("stream", (remote_stream) => {
			console.log("add_call stream", remote_stream)
			call.remote_stream = remote_stream
			
			// call the answer callback, since to receive a remote stream means the call was answered
			trigger_callback("call_answer", call)
			window.clearInterval(call.answer_test_interval)

			// call the remote stream available callback
			trigger_callback("call_stream", call)
		})
		
		// terminate call on error/close
		let terminate_call = () => {
			console.log("add_call terminate")
			trigger_callback("call_ended", call)
			this.calls.delete(call.peer)
			window.clearInterval(call.answer_test_interval)
		}
		call.on("close", terminate_call)
		call.on("error", terminate_call)

		// hack to provide an answer callback function(why is this necessary, peerjs?)
		call.answer_test_interval = window.setInterval(() => {
			if (call.open && !call.was_open) {
				console.log("call answered listen-only")
				trigger_callback("call_answer", call)
				call.was_open = true
				window.clearInterval(call.answer_test_interval)
			}
		}, 333)

		trigger_callback("call_add", call)
		return call
	}

	// answer a call
	this.answer_call = (call, stream_type) => {
		console.log("answer", stream_type, call)
		if (stream_type == "none") {
			call.answer()
			return;
		}
		this.request_self_stream(stream_type, (self_stream) => {
			call.answer(self_stream)
		})
	}

	// unmute own streams(microphone/desktop audio)
	this.mute_self_streams = () => {
		Object.keys(this.self_stream).forEach((e) => {
			this.self_stream[e].getAudioTracks().forEach((t) => t.enabled = false )
		})
	}

	// unmute own streams
	this.unmute_self_streams = () => {
		Object.keys(this.self_stream).forEach((e) => {
			this.self_stream[e].getAudioTracks().forEach((t) => t.enabled = true )
		})
	}

	// mute self(if unmuted sets muted and calls callback)
	this.mute_self = () => {
		if (this.muted) { return; }
		this.muted = true
		this.mute_self_streams()
		trigger_callback("mute_self")
	}

	// unmute self
	this.unmute_self = () => {
		if (!this.muted) { return; }
		this.muted = false
		this.unmute_self_streams()
		trigger_callback("unmute_self")
	}

	// handle the self peer becoming ready
	this.self_peer.on("open", (id) => {
		localStorage.setItem("this_that_last_peer_id", id)
		trigger_callback("open", id)
	})

	// handle incoming calls
	this.self_peer.on("call", (call) => {
		this.crypto_lib.verify_envelope(call.metadata, 5000).then((inner_json) => {
			if (!inner_json) {console.error("Call has invalid signature in metadata!", call.metadata); return; }
			this.add_call(call)
			trigger_callback("call_incoming", call)
		})
	})

	// handle incoming connections
	this.self_peer.on("connection", (con) => {
		this.crypto_lib.verify_envelope(con.metadata, 5000).then((middle_json) => {
			if (!middle_json) {console.error("Connection has invalid signature in metadata!", call.metadata); return; }
			con.profile = this.get_profile_storage(middle_json.public_key_hash)
			this.add_incoming_connection(con)
		})
	})

	this.self_peer.on("error", (err) => {
		console.log("self_peer Error:", err)
	})

}