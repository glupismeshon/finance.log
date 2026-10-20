import {err, csrfOk} from "./util.js";
import * as auth from "./auth.js";
import * as syncApi from "./sync.js";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const p = url.pathname.replace(/\/+$/, "") || "/";
    if (!p.startsWith("/api/")) return env.ASSETS.fetch(request);
    if (!env.APP_ORIGIN) return err("server_misconfigured", 500);
    if (!csrfOk(request, env.APP_ORIGIN)) return err("csrf", 403);
    try {
      const m = request.method;
      if (m === "GET") {
        if (p === "/api/config") return auth.config(env);
        if (p === "/api/me") return await auth.me(env, request);
        if (p === "/api/sync/stats") return await syncApi.stats(env, request);
        if (p === "/api/auth/google/start") return await auth.googleStart(env, request, url);
        if (p === "/api/auth/google/callback") return await auth.googleCallback(env, request, url);
        if (p === "/api/auth/telegram/start") return await auth.telegramStart(env, request, url);
        if (p === "/api/auth/telegram/callback") return auth.telegramCallback(env, url);
      } else if (m === "POST") {
        if (p === "/api/auth/telegram") return await auth.telegramLogin(env, request);
        if (p === "/api/sync") return await syncApi.sync(env, request);
        if (p === "/api/auth/logout") return await auth.logout(env, request, false);
        if (p === "/api/auth/logout-all") return await auth.logout(env, request, true);
      } else if (m === "PATCH") {
        if (p === "/api/me") return await auth.patchMe(env, request);
      } else if (m === "DELETE") {
        if (p === "/api/me/data") return await syncApi.deleteData(env, request);
        const mm = /^\/api\/me\/identities\/([a-z]+)$/.exec(p);
        if (mm) return await auth.unlink(env, request, mm[1]);
      }
      return err("not_found", 404);
    } catch (e) {
      console.error("worker_error", e && e.name); // без деталей: в них могут быть секреты
      return err("server_error", 500);
    }
  }
};
