// app.d.ts
/// <reference types="lucia" />
declare namespace Lucia {
	type Auth = import("lucia").Auth
	type DatabaseUserAttributes = {}
	type DatabaseSessionAttributes = {}
}

declare namespace window {
    type keyFunc = (id: string) => Deno.KvKeyPart[]
}
