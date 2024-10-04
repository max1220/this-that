let storage_objects = {}
function SyncedLocalStorageObject(key, on_update = () => {}, register_event_handler = true) {
	this.on_update = on_update
	this.data = undefined

	// update the data from storage
	this.get_data = () => this.data = JSON.parse(localStorage.getItem(key))
	
	// update the data in localStorage after modifying it
	this.update = (new_data) => {
		this.data = new_data || this.data

		localStorage.setItem(key, JSON.stringify(this.data))
		storage_objects[key] = storage_objects[key] || []
		storage_objects[key].push(this)
		storage_objects[key].forEach((storage_object) => storage_object.on_update(this.data) )
	}

	// listen to storage events if requested
	if (!register_event_handler) { return; }
	window.addEventListener("storage", (e) => {
		if (e.key !== key) { return; }
		this.data = this.get_data()
		storage_objects[key] = storage_objects[key] || []
		storage_objects[key].forEach((storage_object) => storage_object.on_update(this.data) )
	})

	// get the initial data from local storage
	this.on_update(this.get_data())
}
