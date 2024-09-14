// create contacts_list proxy object that automatically syncs contacts to local storage
// and detects storage changes by other documents
let contacts_list_update_cb = undefined
let contacts_list = (function () {
	let contacts_storage_key = "this_that_contacts"

	let get_contacts_list_storage = () => {
		//console.log("get_contacts_list_storage")
		return JSON.parse(localStorage.getItem(contacts_storage_key)) || {}
	}
	let set_contacts_list_storage = (contacts_list) => {
		//console.log("set_contacts_list_storage",contacts_list)
		localStorage.setItem(contacts_storage_key, JSON.stringify(contacts_list))
	}

	let contacts_list_data = get_contacts_list_storage()
	let contacts_list_handler = {
		get: (target, property, receiver) => {
			target_get = Reflect.get(target, property, receiver)
			if (target_get) { return target_get; }
			//console.log("contacts get", property)
			return contacts_list_data[property]
		},
		set: (target, property, value, receiver) => {
			//console.log("contacts set", property, value)
			contacts_list_data[property] = value
			set_contacts_list_storage(contacts_list_data)
		},
		deleteProperty: (target, property) => {
			if (property in contacts_list_data) {
				//console.log("contacts delete", property)
				delete contacts_list_data[property]
				set_contacts_list_storage(contacts_list_data)
			}
		},
	}
	window.addEventListener("storage", (e) => {
		if (e.key == contacts_storage_key) {
			//console.log("contacts storage event", e)
			contacts_list_data = get_contacts_list_storage()
			if (contacts_list_update_cb) {
				contacts_list_update_cb(contacts_list_data)
			}
		}
	})
	let contacts_list_obj = {
		keys: () => { return Object.keys(contacts_list_data) },
	}
	return new Proxy(contacts_list_obj, contacts_list_handler)
})()