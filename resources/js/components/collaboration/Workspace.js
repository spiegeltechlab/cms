import * as Y from 'yjs';
import * as yProsemirror from 'y-prosemirror';
import AwarenessManager from "./AwarenessManager";
import ProviderManager from "./ProviderManager";
import { textUpdate } from "./text.js"
import DirtyStateManager from './DirtyStateManager';

// Todo: Add information what a Workspace is, why needed etc.
export default class Workspace {
    constructor(container) {
        this.container = container;
        this.dirtyState = null;
        this.started = false;
        this.synced = false;
        this.document = null;
        this.fieldsets = [];
        this.Y = Y;
        this.yProsemirror = yProsemirror;
        this.awarenessManager = {};
        this.providerManager = {};
    }

    start() {
        if (this.started) return;
        this.started = true;

        this.document = new Y.Doc();
        this.initializeProviderSetup();
        this.awarenessManager = new AwarenessManager();

        this.providerManager.provider.on('status', event => {
            if (event.status === 'connected' && !this.synced) {
                this.awarenessManager.start(this.container, this.providerManager.provider?.awareness);
                this.initializeBlueprint();
                this.initializeDirtyState();
            }
        });

        this.providerManager.provider.on('synced', event => {
            if (!event || this.synced) return;
            this.synced = true;
            this.initializeWebsocket();
            this.syncLocalChanges();
            this.observeYChanges();
        });
    }

    beforeDestroy() {
        window.removeEventListener('online');
        window.removeEventListener('offline');
    }

    initializeProviderSetup() {
        this.providerManager = new ProviderManager();
        this.providerManager.start(this.container.reference, this.document);
    }

    initializeDirtyState() {
        this.dirtyState = new DirtyStateManager(this);
        this.dirtyState.initialize();
    }

    // TODO: Move into SyncManager
    initializeBlueprint() {
        this.container.blueprint.sections.forEach(section => {
            section.fields.forEach(field => {
                this.fieldsets.push({
                    handle: field.handle,
                    collaborationType: field.collaboration,
                    type: field.type,
                });
            })
        });
    }

    // TODO: Move into ProviderManager
    initializeWebsocket() {
        this.fieldsets.forEach(field => {

            switch (field.collaborationType) {
                case 'text':
                    if (this.awarenessManager.users.length > 1) {
                        // If there are more than two users in the document, fetch the YJS data and publish it to the form.    
                        Statamic.$store.dispatch(`publish/${this.container.name}/setCollaborationFieldValue`, {
                            handle: field.handle,
                            user: Statamic.user.id,
                            value: this.document.getText(field.handle).toString() ?? ''
                        });
                    } else {
                        // In case only one user has been logged in, we want to reset the websocket.                        
                        this.document.transact(() => {
                            // Delete websocket data in case some data does exist.
                            if (this.document.getText(field.handle).length > 0) {
                                this.document.getText(field.handle).delete(0, this.document.getText(field.handle).length)
                            }
                            // Initialize the websocket
                            this.document.getText(field.handle).insert(0, this.container.values[field.handle]);
                        })
                    }
                    break;
                default:
                    console.debug('The field', field.handle, 'will not be synced via YJS.')
            }
        })
    }

    // TODO: Move into SyncManager
    syncLocalChanges() {
        Statamic.$store.subscribe((mutation, state) => {
            if (mutation.type !== `publish/${this.container.name}/setFieldValue`) return;

            // Ignore bard fields for now. We need a better approach
            if (this.getFieldsetType(mutation.payload.handle) === 'bard') return;

            // TODO: Check for collaboration type and sync accordingly

            textUpdate(
                mutation.payload.handle,
                this.document.getText(mutation.payload.handle),
                mutation.payload.value,
                this.document.getText(mutation.payload.handle).toString(),
                mutation.payload.position,
            )
        });

    }

    // TODO: Move into SyncManager
    observeYChanges() {
        this.fieldsets.forEach(field => {

            switch (field.collaborationType) {
                case 'text': // TODO: Create syncingType
                    this.document.getText(field.handle).observe(event => {
                        console.debug('EVENT', event)

                        let toUpdate = [];
                        let from = 0;
                        let length = 0; // Fallback

                        event.delta.forEach((delta) => {

                            if (delta.retain) {
                                from = delta.retain;
                            } else if (delta.insert) {
                                length += delta.insert.length; // Get length as its a string
                            } else if (delta.delete) {
                                length -= delta.delete; // Will return the deleted characters as int
                            }

                            // Sometimes multiple deltas will be fired at once. 
                            // To avoid workload, we'll remeber those so we can make a single update after fetching alle changes.
                            if (toUpdate.includes(field.handle)) return;

                            toUpdate.push(field.handle)
                        })

                        if (Statamic.user.cursor) {
                            Statamic.user.cursor.move = {
                                from: from,
                                length: length,
                            }
                        }

                        // Working through each field only once.

                        // If it's a local change, we don't need to fire the collaboration field value command. 
                        // This does prevent a race condition as well.
                        if (!event.transaction.local) {

                            toUpdate.forEach(handle => {
                                Statamic.$store.dispatch(`publish/${this.container.name}/setCollaborationFieldValue`, {
                                    handle: handle,
                                    user: Statamic.user.id,
                                    value: this.document.getText(handle).toString()
                                });
                            })

                        }

                        // Reset fields we did update
                        toUpdate = []

                    })
                    break;
            }
        })
    }

    // ??
    getFieldsetType(handle) {
        return this.fieldsets.find(fieldset => fieldset.handle === handle).type;
    }

    dirty() {
        if (!this.dirtyState) return;

        this.dirtyState.dirty();
    }

    clearDirtyState() {
        if (!this.dirtyState) return;

        this.dirtyState.clear();
    }
}
