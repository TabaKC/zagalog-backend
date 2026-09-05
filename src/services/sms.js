/**
 * sms.js — sends OTP codes via Africa's Talking SMS API.
 *
 * Africa's Talking covers South Africa well and has a free sandbox.
 * Docs: https://developers.africastalking.com/docs/sms/sending
 */

const https = require("https");
const querystring = require("querystring");

/**
 * Generate a 6-digit numeric OTP.
 */
function generateOtp() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

/**
 * Send an SMS via Africa's Talking.
 * In sandbox mode (AT_USERNAME=sandbox) messages are not delivered
 * to real phones — check the AT dashboard to see them.
 */
async function sendOtp(phoneNumber, code) {
  // In dev, just log the code instead of hitting the API
  if (process.env.NODE_ENV === "development") {
    console.log(`[DEV] OTP for ${phoneNumber}: ${code}`);
    return;
  }

  const params = querystring.stringify({
    username: process.env.AT_USERNAME,
    to: phoneNumber,
    message: `Your Duka verification code is ${code}. Valid for 10 minutes.`,
    from: process.env.AT_SENDER_ID || "Duka",
  });

  return new Promise((resolve, reject) => {
    const options = {
      hostname: "api.africastalking.com",
      path: "/version1/messaging",
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
        apiKey: process.env.AT_API_KEY,
        "Content-Length": Buffer.byteLength(params),
      },
    };

    const req = https.request(options, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => {
        try {
          const json = JSON.parse(body);
          const recipient = json.SMSMessageData?.Recipients?.[0];
          if (recipient?.statusCode === 101) {
            resolve(json);
          } else {
            reject(new Error(`AT error: ${recipient?.status || body}`));
          }
        } catch {
          reject(new Error("Failed to parse AT response"));
        }
      });
    });

    req.on("error", reject);
    req.write(params);
    req.end();
  });
}

module.exports = { generateOtp, sendOtp };
