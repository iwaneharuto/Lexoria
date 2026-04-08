import authHandler from "./index.js";

export default async function handler(req, res) {
  req.body = { ...(req.body || {}), action: "sync-profile" };
  return authHandler(req, res);
}
