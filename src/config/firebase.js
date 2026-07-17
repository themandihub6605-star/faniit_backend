const admin = require('firebase-admin');

/**
 * Initializes Firebase Admin using service-account credentials from env vars.
 * Get these from: Firebase Console -> Project Settings -> Service Accounts
 * -> "Generate new private key".
 *
 * Required .env vars:
 *   FIREBASE_PROJECT_ID
 *   FIREBASE_CLIENT_EMAIL
 *   FIREBASE_PRIVATE_KEY   (keep the \n escape sequences as-is — see below)
 *
 * The private key from the downloaded JSON file contains literal newlines;
 * when pasted into a single .env line those become the two-character
 * sequence \n, so we convert them back to real newlines here.
 */
let initialized = false;

function getFirebaseAdmin() {
  if (!initialized) {
    const projectId = process.env.FIREBASE_PROJECT_ID;
    const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
    const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n');

    if (!projectId || !clientEmail || !privateKey) {
      throw new Error(
        'Firebase Admin is not configured. Set FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL and FIREBASE_PRIVATE_KEY in .env — see src/config/firebase.js for where to get them.'
      );
    }

    admin.initializeApp({
      credential: admin.credential.cert({ projectId, clientEmail, privateKey }),
    });
    initialized = true;
  }
  return admin;
}

module.exports = { getFirebaseAdmin };
