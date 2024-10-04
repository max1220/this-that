"use strict";
/*

This library contains all JavaScript cryptographic library functions relevant to the
operation of the This-That web application.
In particular, because peer.js IDs are not a great way to identify and trust people,
as needed by a chat application, a better way of verifying who you are is needed.

In this case, an RSA-PSS signature is used to sign profile updates,
which can be verified against a users's public key.

Because there is no central user registry, as required by the nature of this application,
the public keys used for signing are used to identify users as well.

*/
function CryptoLib() {
	// get access to the keys stored in LocalStorage
	this.self_signature_public_key_storage = new SyncedLocalStorageObject("this_that_self_signature_public_key")
	this.self_signature_private_key_storage = new SyncedLocalStorageObject("this_that_self_signature_private_key")

	// hash strings
	let hash_str = (str) => window.crypto.subtle.digest("SHA-256", new TextEncoder().encode(str))

	// generate hex-dump of array-like object
	let hex_dump = (data) => (Array.prototype.map.call(new Uint8Array(data), e => e.toString(16).padStart(2, "0"))).join("")

	// generate the hash for a public key
	this.public_key_hash = async (public_key_jwk) => hex_dump(await hash_str(public_key_jwk.n))

	// compare two public keys for equality
	this.compare_public_key_jwk = (public_key_a, public_key_b) => {
		return (public_key_a.kty == public_key_b.kty) && 
			(public_key_a.alg == public_key_b.alg) && 
			(public_key_a.n == public_key_b.n) &&
			(public_key_a.e == public_key_b.e)
	}

	// import the specified JWKs as own signing keys
	this.import_own_signature_keys = async (private_key_jwk, public_key_jwk) => {
		let public_key = await window.crypto.subtle.importKey("jwk", public_key_jwk, { name: "RSA-PSS", hash: "SHA-256" }, true, ["verify"])
		if (!public_key) { console.error("Can't import public key!"); return; }
		let private_key = await window.crypto.subtle.importKey("jwk", private_key_jwk, { name: "RSA-PSS", hash: "SHA-256" }, true, ["sign"])
		if (!private_key) { console.error("Can't import private key!"); return; }
		this.self_signature_public_key_storage.update(public_key_jwk)
		this.self_signature_private_key_storage.update(private_key_jwk)
		return true
	}

	// generate a keypair for creating/verifying signatures
	this.generate_own_signature_keys = async () => {
		let signature_key_config = {
			name: "RSA-PSS",
			modulusLength: 4096,
			publicExponent: new Uint8Array([1, 0, 1]),
			hash: "SHA-256",
		}
		return window.crypto.subtle.generateKey(signature_key_config, true, ["sign", "verify"])
	}

	// import(or generate if not found) the users RSA key pair for encryption/decryption/sign/verify
	// generated key is stored in localStorage using SyncedLocalStorageObject
	this.import_or_generate_own_signature_keys = async () => {
		if (this.self_signature_public_key_storage.data && this.self_signature_private_key_storage.data) {
			let public_key = await window.crypto.subtle.importKey("jwk", this.self_signature_public_key_storage.data, { name: "RSA-PSS", hash: "SHA-256" }, true, ["verify"])
			let private_key = await window.crypto.subtle.importKey("jwk", this.self_signature_private_key_storage.data, { name: "RSA-PSS", hash: "SHA-256" }, true, ["sign"])
			return {
				public_key: public_key,
				private_key: private_key,
				public_key_jwk: this.self_signature_public_key_storage.data,
				private_key_jwk: this.self_signature_private_key_storage.data,
			}
		} else {
			let key_pair = await this.generate_own_signature_keys()
			let public_key_jwk = await window.crypto.subtle.exportKey("jwk", key_pair.publicKey)
			let private_key_jwk = await window.crypto.subtle.exportKey("jwk", key_pair.privateKey)
			this.self_signature_public_key_storage.update(public_key_jwk)
			this.self_signature_private_key_storage.update(private_key_jwk)
			return {
				public_key: key_pair.publicKey,
				private_key: key_pair.privateKey,
				public_key_jwk: public_key_jwk,
				private_key_jwk: private_key_jwk,
			}
		}
	}

	// verify data using public key
	this.verify_data = async (public_key, signature, data) => 
		window.crypto.subtle.verify({ name: "RSA-PSS", saltLength: 32 }, public_key, signature, data)
		
	// sign data using private key
	this.sign_data = async (private_key, data) =>
		window.crypto.subtle.sign({ name: "RSA-PSS", saltLength: 32 }, private_key, data)

	// create a cryptographically signed envelope object containing the inner data
	this.sign_envelope = async (inner_data) => {
		let signature_keys = await this.import_or_generate_own_signature_keys()
		let public_key_hash = await this.public_key_hash(signature_keys.public_key_jwk)
		let middle_json = JSON.stringify({
			time: new Date().toISOString(),
			public_key_jwk: signature_keys.public_key_jwk,
			public_key_hash: public_key_hash,
			inner_data: inner_data,
		})
		let middle_json_bytes = new TextEncoder().encode(middle_json)
		let signature_bytes = await this.sign_data(signature_keys.private_key, middle_json_bytes)
		let outer_envelope = {
			public_key_jwk: signature_keys.public_key_jwk,
			public_key_hash: public_key_hash,
			signature: [...new Uint8Array(signature_bytes)],
			middle_json: middle_json,
		}
		return outer_envelope
	}

	// verify a cryptographically signed envelope object, and return the inner data if valid
	// if expected_public_key_hash is not specified, the signed envelope is only checked for consistency
	this.verify_envelope = async (outer_envelope, expected_public_key_hash) => {
		if (expected_public_key_hash && (outer_envelope.public_key_hash !== outer_envelope.public_key_hash)) {
			console.error("Expected public key does not match. Got:",outer_envelope.public_key_hash, "Expected:", expected_public_key_hash)
			return
		}
		let profile_public_key = await window.crypto.subtle.importKey("jwk", outer_envelope.public_key_jwk, { name: "RSA-PSS", hash: "SHA-256" }, true, ["verify"])
		let middle_json_bytes = new TextEncoder().encode(outer_envelope.middle_json)
		let signature_bytes = new Uint8Array(outer_envelope.signature)
		let is_valid_signature = await this.verify_data(profile_public_key, signature_bytes, middle_json_bytes)
		if (!is_valid_signature) {
			console.error("Invalid signature!", outer_envelope)
			return
		}
		let middle_json = JSON.parse(outer_envelope.middle_json)
		if (middle_json.public_key_hash !== outer_envelope.public_key_hash) {
			console.error("Inner and envelope public keys hashed don't match!", outer_envelope)
			return
		}
		let generated_hash = await this.public_key_hash(middle_json.public_key_jwk)
		if (generated_hash !== middle_json.public_key_hash) {
			console.error("Public key hash does not match key!", outer_envelope)
			return
		}
		if (!this.compare_public_key_jwk(middle_json.public_key_jwk, outer_envelope.public_key_jwk)) {
			console.error("Inner and envelope public keys don't match!", outer_envelope)
			return
		}
		return middle_json
	}
}
