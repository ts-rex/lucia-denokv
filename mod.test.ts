import * as assert from "https://deno.land/std@0.213.0/assert/mod.ts";
import { luciaKvAdapter } from "./mod.ts"
import { Lucia, TimeSpan } from "lucia";
import { openKv } from "kv"

function sleep(seconds: number) {
    return new Promise((resolve) => setTimeout(resolve, seconds * 1000))
}

Deno.test("Test without auto expire", async (t) => {
    const db = await openKv();
    const adapter = luciaKvAdapter(db, {
        experimental: {
            logging: true
        }
    });
    const lucia = new Lucia(adapter.adapter, {
        sessionExpiresIn: new TimeSpan(1, 's')
    })
    await t.step("session cr(u)d", async t => {
        let session_id: string;
        await t.step("create user & session", async _ => {
            db.set(adapter.keys.user('mockUser'), { username: "mock" })
            const session = await lucia.createSession('mockUser', {});
            session_id = session.id
        })
        await t.step("read session & user", async _ => {
            const session = await lucia.validateSession(session_id);
            assert.assertExists(session.session)
            assert.assertExists(session.user)
            assert.assertEquals(session.session?.id, session_id)
        })
        await t.step("delete session & user", async _ => {
            new Array(100).map(() => 0).forEach(async () => await lucia.createSession('mockUser', {}));
            await adapter.deleteUser('mockUser', async (_tx, _userId) => {
                // here we would delete any data that needs to be cascaded on delete 
                // (e.g. delete all user posts when user is deleted)
                // use tx to delete any user data
                // automatically deletes user sessions
                //! DO NOT tx.commit(), it will be done for you!
            });
        })
    })
    await t.step("session expiration", async t => {
        let phone_session_id: string;
        let laptop_session_id: string;
        await t.step("create a user & session", async _ => {
            db.set(adapter.keys.user('mockUser2'), { username: "mockwastaken" })
            console.log("user creates an account on their phone")
            const session = await lucia.createSession('mockUser2', {});
            phone_session_id = session.id
            console.log("phone session expires...")
            await sleep(1);
        })
        await t.step("create another session", async _ => {
            console.log("use logs into their account on their laptop")
            const session = await lucia.createSession('mockUser2', {});
            laptop_session_id = session.id
        })
        await t.step("deleteExpiredSessions() should delete only the phone session", async t => {
            await t.step("check the phone session still exists", async _ => {
                const [session, user] = await adapter.adapter.getSessionAndUser(phone_session_id)
                assert.assertExists(session)
                assert.assertExists(user)
            })
            await t.step("Delete Expired Sessions", async _ => {
                await lucia.deleteExpiredSessions()
            })
            await t.step("make sure phone session was deleted.", async _ => {
                const [session, user] = await adapter.adapter.getSessionAndUser(phone_session_id)
                assert.assertEquals(session, null)
                assert.assertEquals(user, null)
            })
            await t.step("make sure laptop session was NOT deleted", async _ => {
                const [session, user] = await adapter.adapter.getSessionAndUser(laptop_session_id)
                assert.assertExists(session)
                assert.assertExists(user)
            })
        })
    })
    db.close()
})

Deno.test("Test with auto expire on", async (t) => {
    Deno.env.set("DENO_KV_ACCESS_TOKEN", "MYPASSWORD1234") // I don't think the npm version actually uses the env variable, but I THINK it just uses the deno implementation if it detects deno.
    const db = await openKv('http://0.0.0.0:4512');
    const adapter = luciaKvAdapter(db, {
        experimental: {
            logging: true,
            auto_expire: true
        }
    });
    const lucia = new Lucia(adapter.adapter, {
        sessionExpiresIn: new TimeSpan(1, 's')
    })
    await t.step("session expiration", async t => {
        let session_id: string;
        await t.step("create a user & session", async _ => {
            db.set(adapter.keys.user('mockUser3'), { username: "mockwastakenagain" })
            console.log("user creates an account")
            const session = await lucia.createSession('mockUser3', {});
            session_id = session.id;
            const [fetched_session, fetched_user] = await adapter.adapter.getSessionAndUser(session_id);
            console.log(fetched_session, fetched_user)
        })
        await t.step("force expire session", async _ => {
            await sleep(5);
        })
        await t.step("make sure session is deleted", async _ => {
            const [session, user] = await adapter.adapter.getSessionAndUser(session_id)
            console.log(session, user)
            assert.assertEquals(session, null)
            assert.assertEquals(user, null)
        })
    })
})