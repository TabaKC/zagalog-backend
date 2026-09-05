const jwt = require("jsonwebtoken");

/**
 * Verifies the Bearer JWT in the Authorization header.
 * Attaches { merchantId, phone } to req.merchant on success.
 */
function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: "Missing auth token." });
  }

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.merchant = { id: payload.sub, phone: payload.phone };
    next();
  } catch (err) {
    return res.status(401).json({ error: "Invalid or expired token." });
  }
}

module.exports = { requireAuth };
