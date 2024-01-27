import * as assert from "https://deno.land/std@0.213.0/assert/mod.ts";
import { kv } from "./mod.ts"
import { Lucia } from "lucia";

Deno.test(async function test(t) {
    const denoKV = await Deno.openKv();
    const adapter = kv(denoKV, {
        experimental: {
            logging: true
        }
    });
    const lucia = new Lucia(adapter.adapter)
    await t.step("session crd", async t => {
        let session_id: string;
        await t.step("create user & session", async t => {
            denoKV.set(adapter.userKey('mockUser'), { username: "mock" })
            const session = await lucia.createSession('mockUser', {});
            session_id = session.id
        })
        await t.step("read session & user", async t => {
            const session = await lucia.validateSession(session_id);
            assert.assertExists(session.session)
            assert.assertExists(session.user)
            assert.assertEquals(session.session?.id, session_id)
        })
        await t.step("delete session & user", async t => {
            await adapter.deleteUser('mockUser', async (tx, userId) => {
                // here we would delete any data that needs to be cascaded on delete 
                // (e.g. delete all user posts when user is deleted)
                // use tx to delete any user data
                // automatically deletes user sessions
                //! DO NOT tx.commit(), it will be done for you!
            });
        })
    })
    await t.step("delete expired sessions", async t => {
        // this hasn't been implemented yet. it should throw
        assert.assertRejects(async () => await lucia.deleteExpiredSessions())
    })
    denoKV.close()
})