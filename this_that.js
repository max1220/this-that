"use strict";

function ThisThat() {
	let last_id = localStorage.getItem("this_that_last_peer_id")
	this.self_peer = new Peer(last_id)
	this.connections = new Map()
	this.calls = new Map()
	this.self_stream = {}
	this.callbacks = {}
	this.crypto_lib = new CryptoLib()
	
	// trigger a callback function if present
	let trigger_callback = (name, arg) => {
		if (!this.callbacks[name]) { return; }
		return this.callbacks[name](arg)
	}

	// storage for own profile
	this.self_profile_storage = new SyncedLocalStorageObject("this_that_self_profile", (self_profile_data) => trigger_callback("self_profile_update", self_profile_data))
	if (!this.self_profile_storage.data) {
		console.log("No profile! Generating one...")
		this.self_profile_storage.update({
			username: "Unnamed user #" + Math.floor(10000+Math.random()*90000),
			content: "<h1>Hello World!</h1>\n<p>This is the default profile. <b>Hurray!</b></p>"
		})
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
	this.get_profile_storage = (public_key_hash, on_update, create_profile) => {
		if (!public_key_hash) { console.error("Need public_key_hash!"); return; }
		if (!create_profile && !this.has_profile_storage(public_key_hash)) { console.error("No profile!"); return; }
		let profile_storage = new SyncedLocalStorageObject("this_that_profile_"+public_key_hash, on_update)
		if (create_profile && !profile_storage.data) {
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
		let middle_json = await this.crypto_lib.verify_envelope(profile_update_envelope, 5000)
		if (!middle_json) { console.error("Profile update could not be verified!"); return; }
		if (middle_json.inner_data.peer_id !== con.peer) { console.error("Peer ID mismatch!", con.peer, middle_json.inner_data); return; }
		let profile_storage = this.get_profile_storage(middle_json.public_key_hash, undefined, true)
		profile_storage.data.profile_data = middle_json.inner_data
		profile_storage.data.last_seen = new Date().toISOString()
		profile_storage.update()
		// detect if this connection just gained it's profile(became authenticated)
		if (!con.profile) {
			con.profile = profile_storage
			trigger_callback("connection_profile_ready", con)
			if (con.profile_ready_cb) { con.profile_ready_cb(con); }
		}
		con.profile = profile_storage
		console.log("handle_profile_update", profile_storage)
		trigger_callback("profile_update", profile_storage)
	}




	// handle the self peer becoming ready
	this.self_peer.on("open", (id) => {
		localStorage.setItem("this_that_last_peer_id", id)
		this.self_profile_storage.data.peer_id = id
		this.self_profile_storage.update()

		// get own signing keys
		this.crypto_lib.import_or_generate_own_signature_keys().then((keys) => {
			this.signature_keys = keys
			this.crypto_lib.public_key_hash(keys.public_key_jwk).then((hash) => {
				this.self_profile_storage.data.public_key_jwk = keys.public_key_jwk
				this.self_profile_storage.data.public_key_hash = hash
				this.self_profile_storage.update()
				trigger_callback("ready", id)
			})
		})
	})

	// handle a self peer error
	this.self_peer.on("error", (err) => {
		console.error("self_peer Error:", err)
	})



	// send a message to the specified peer_id(waits for authentication first)
	this.send_to_peer = (peer_id, data) => {
		if (this.connections.has(peer_id)) {
			// already has a connection, send immediately
			this.connections.get(peer_id).send(data)
		} else {
			// need a new connection, send when the connection becomes authenticated
			this.add_outgoing_connection(peer_id, (con) => {
				con.send(data)
			})
		}
	}

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

	// notify all connected peers that your profile has changed
	this.broadcast_profile_update = () => {
		for (let con of this.connections.values()) {
			this.send_profile_update(con)
		}
	}

	// handle a chat message from a user
	this.handle_chat_message = (con, message) => {
		let now = new Date().toISOString()
		con.profile.data.chat_history.push({ from: con.profile.public_key_hash, time: now, arg: message })
		con.profile.update()
		trigger_callback("chat_message", { from: con, time: now, arg: message})
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

	// TODO: HACK: needed because commands need to be processesed in order,
	// but processing them is async, and commands are triggered by an event handler
	this.check_con_data_hack = () => {
		for (let con of this.connections.values()) {
			if (con.data_ready && (con.data_buf.length > 0)) {
				con.data_ready = false
				this.handle_data(con, con.data_buf.shift()).then(() => {
					con.data_ready = true
				})
			}
		}
	}
	setInterval(this.check_con_data_hack, 60)

	// create an outgoing connection(call profle_ready_cb when the connection has a profile(is authenticated))
	this.add_outgoing_connection = (peer_id, profile_ready_cb) => {
		if (this.connections.has(peer_id)) { console.error("Already has connection with peer!"); return; }
		//let con = this.self_peer.connect(peer_id, { reliable: true })
		let con = this.self_peer.connect(peer_id)
		con.profile_ready_cb = profile_ready_cb
		console.log("add_outgoing_connection?", peer_id, con)
		con.on("open", () => {
			console.log("add_outgoing_connection: open", con)
			this.add_connection(con)
			this.send_profile_update(con)
		})
		con.on("close", () => {
			console.warn("add_outgoing_connection: Connection closed")
		})
		con.on("error", (err) => {
			console.error("add_outgoing_connection: error: ", err)
		})
		return con
	}

	// handle an incoming connection
	this.add_incoming_connection = (con) => {
		if (this.connections.has(con.peer)) { console.error("Already has connection with peer!"); return; }
		console.log("add_incoming_connection", con._open, con)
		con.profile_ready_cb = () => {
			this.send_profile_update(con)
		}
		this.add_connection(con)
		return con
	}

	// add a connection to the list of active connections
	this.add_connection = (con) => {
		// update the connections list(only one active connection per peer!)
		if (this.connections.has(con.peer)) { console.warn("Already had a connection with",con.peer, ", closing old connection"); this.connections.get(con.peer).close(); }
		this.connections.set(con.peer, con)
		// hack needed because the on data function isn't used in an async way(can't process items out-of-order, handle_data is async)
		con.data_buf = []
		con.data_ready = true
		con.on("data", async (data) => {
			con.data_buf.push(data)
		})
		con.on("close", () => {
			this.connections.delete(con.peer)
			trigger_callback("connection_close", con)
		})
		con.on("error", () => {
			con.close()
			this.connections.delete(con.peer)
			trigger_callback("connection_error", con)
		})
		trigger_callback("connection_add", con)
		return con
	}

	// handle incoming connections
	this.self_peer.on("connection", (con) => {
		this.add_incoming_connection(con)	
	})



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
			console.log("XXXXXXXXXX")
			navigator.mediaDevices.getUserMedia({audio: true}).then(handle_stream).catch((err) => {console.log("MediaStream error", err); remove_stream();})
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

	// handle incoming calls
	this.self_peer.on("call", (call) => {
		this.crypto_lib.verify_envelope(call.metadata).then((inner_json) => {
			if (!inner_json) {console.error("Call has invalid signature in metadata!", call.metadata); return; }
			this.add_call(call)
			trigger_callback("call_incoming", call)
		})
	})



}