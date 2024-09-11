function ThisThat() {
	let last_id = localStorage.getItem("this_that_last_peer_id")
	this.self_peer = new Peer(last_id)
	this.connections = new Map()
	this.calls = new Map()
	this.self_identity = {}
	this.self_audio_stream = undefined
	this.self_video_stream = undefined
	this.callbacks = {}
	
	// trigger a callback function if present
	let trigger_callback = (name, arg) => {
		if (!this.callbacks[name]) { return; }
		return this.callbacks[name](arg)
	}

	// get own audio/video stream
	this.request_self_stream = (video_ena, stream_cb) => {
		if (!this.self_audio_stream) {
			navigator.mediaDevices.getUserMedia({audio: true}).then((audio_stream) => {
				this.self_audio_stream = audio_stream
				if (!video_ena) {
					if (stream_cb) { stream_cb(audio_stream); }
					trigger_callback("self_audio_stream", audio_stream)
				}
			})
		}
		if (!this.self_video_stream && video_ena) {
			navigator.mediaDevices.getUserMedia({video: true, audio: true}).then((video_stream) => {
				this.self_video_stream = video_stream
				stream_cb(video_stream)
				trigger_callback("self_video_stream", video_stream)
			})
		}
	}

	// send own identity to connection
	this.identify_to = (con) => {
		con.send({command: "identify", arg: this.self_identity})
	}

	// handle data from a connection
	this.handle_data = (con, data) => {
		if (data.command == "identify") {
			con.identity = data.arg
			trigger_callback("identify", { from: con, arg: data.arg} )
		} else if (data.command == "chat_message") {
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

	// handle the self peer becoming ready
	this.self_peer.on("open", (id) => {
		localStorage.setItem("this_that_last_peer_id", id)
		trigger_callback("open", id)
	})

	// handle incoming connections
	this.self_peer.on("connection", (con) => {
		this.add_connection(con)
	})

	// initiate a new call with a peer
	this.call_peer = (peer_id, video_ena, stream_cb) => {
		if (this.calls.has(peer_id)) { return this.calls.get(peer_id); }
		if (!this.self_stream) {
			this.request_self_stream(video_ena, (stream) => this.add_call(this.self_peer.call(peer_id, stream), stream_cb))
		} else {
			this.add_call(this.self_peer.call(peer_id, stream), stream_cb)
		}
	}

	// add a call to the list of active calls
	this.add_call = (call, stream_cb) => {
		if (this.calls.has(this.calls.peer)) { call.close(); return this.calls.get(call.peer); }
		this.calls.set(call.peer, call)
		call.on("stream", (remote_stream) => {
			call.remote_stream = remote_stream
			if (stream_cb) { stream_cb(call); }
			trigger_callback("call_stream", call)
		})
		call.on("close", () => {
			trigger_callback("call_ended", call)
			this.calls.delete(call.peer)
		})
		call.on("error", () => {
			trigger_callback("call_ended", call)
			this.calls.delete(call.peer)
		})
		return call
	}

	// answer a call
	this.answer_call = (call, self_audio_ena, self_video_ena) => {
		if (!self_audio_ena && !self_video_ena) {
			call.answer()
		} else {
			if (this.self_stream) {
				call.answer(this.self_stream)
			} else {
				this.request_self_stream(self_video_ena, () => call.answer(this.self_stream))
			}
		}
	}

	// handle incoming calls
	this.self_peer.on("call", (call) => {
		this.add_call(call)
		trigger_callback("call_incoming", call)
	})
}