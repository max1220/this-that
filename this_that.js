"use strict";

function ThisThat() {
	let last_id = localStorage.getItem("this_that_last_peer_id")
	this.self_peer = new Peer(last_id)
	this.connections = new Map()
	this.calls = new Map()
	this.self_identity = {}
	this.self_stream = {}
	this.callbacks = {}
	
	// trigger a callback function if present
	let trigger_callback = (name, arg) => {
		if (!this.callbacks[name]) { return; }
		return this.callbacks[name](arg)
	}

	// send own identity to connection
	this.identify_to = (con) => {
		con.send({command: "identify", arg: this.self_identity})
	}

	// handle data from a connection
	this.handle_data = (con, data) => {
		if (trigger_callback("connection_data", { con: con, data: data })) {
			// callback handled data
		} else if (data.command == "profile_update") {
			// update the profile associated with this peer
			con.profile = data.arg
		} else if (data.command == "chat_message") {
			// handle chat message
			con.chat_history.push(data.arg)
			trigger_callback("chat_message", { from: con, arg: data.arg})
		} else {
			console.error("Unknown message from peer:", data)
		}
	}

	// add a new connection to the list of active connections
	this.add_connection = (con) => {
		if (this.connections.has(con.peer)) { con.close(); return this.connections.get(con.peer); }
		this.connections.set(con.peer, con)
		this.identify_to(con)
		con.chat_history = []
		con.on("data", (data) => {
			this.handle_data(con, data)
		})
		con.on("close", () => {
			this.connections.delete(con.peer)
		})
		trigger_callback("connection", con)
		return con
	}

	// connect to a remote peer for status updates and chat messages
	this.connect_peer = (peer_id, open_cb) => {
		if (this.connections.has(peer_id)) { return this.connections.get(peer_id); }
		let con = this.self_peer.connect(peer_id)
		con.on("open", () => {
			this.add_connection(con)
			if (open_cb) { open_cb(con); }
		})
		return con
	}

	// send a chat message(connect first if needed)
	this.send_chat_message = (peer_id, message) => {
		let con = this.connections.get(peer_id)
		let message_cmd = {
			command: "chat_message",
			arg: message
		}
		if (con) {
			con.send(message_cmd)
		} else {
			this.connect_peer(peer_id, (new_con) => new_con.send(message_cmd) )
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
			stream_cb(stream)
			// stream.getTracks().forEach((track) => { track.onended = remove_stream; })
			trigger_callback("self_stream_added", { stream_type: stream_type, stream: stream })
		}
		console.log("request_self_stream", stream_type)
		if (stream_type == "audio") {
			navigator.mediaDevices.getUserMedia({audio: true}).then(handle_stream) //.catch(remove_stream)
		} else if (stream_type == "video") {
			navigator.mediaDevices.getUserMedia({audio: true, video: true}).then(handle_stream).catch(remove_stream)
		} else if (stream_type == "screen") {
			navigator.mediaDevices.getDisplayMedia({systemAudio: "include"}).then(handle_stream).catch(remove_stream)
		} else {
			console.error("Invalid stream_type:",stream_type)
		}
	}

	// initiate a new call with a peer
	this.call_peer = (peer_id, stream_type) => {
		if (this.calls.has(peer_id)) { console.warn("Already has a call with peer!"); return; }
		this.request_self_stream(stream_type, (self_stream) => {
			console.log("Calling peer using stream:", stream_type, self_stream)
			let call = this.self_peer.call(peer_id, self_stream)
			call.self_stream = self_stream
			this.add_call(call)
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

	// mute own microphone
	this.mute_self = () => {
		if (this.muted) { return; }
		this.muted = true
		Object.keys(this.self_stream).forEach((e) => {
			this.self_stream[e].getAudioTracks().forEach((t) => t.enabled = false )
		})
		trigger_callback("mute_self")
	}

	// unmute own microphone
	this.unmute_self = () => {
		if (!this.muted) { return; }
		this.muted = false
		Object.keys(this.self_stream).forEach((e) => {
			this.self_stream[e].getAudioTracks().forEach((t) => t.enabled = true )
		})
		trigger_callback("unmute_self")
	}

	// handle the self peer becoming ready
	this.self_peer.on("open", (id) => {
		localStorage.setItem("this_that_last_peer_id", id)
		trigger_callback("open", id)
	})

	// handle incoming calls
	this.self_peer.on("call", (call) => {
		this.add_call(call)
		trigger_callback("call_incoming", call)
	})

	// handle incoming connections
	this.self_peer.on("connection", (con) => {
		this.add_connection(con)
	})

}