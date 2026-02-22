import express from "express";
import dotenv from "dotenv";
import cors from "cors";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import admin from "firebase-admin";
import { readFileSync } from "fs";

dotenv.config();

// ─────────────────────────────────────────
// FIREBASE INIT
// ─────────────────────────────────────────
const serviceAccount = JSON.parse(readFileSync("./serviceAccountKey.json", "utf8"));

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();

const app = express();
app.use(cors());
app.use(express.json());

// ─────────────────────────────────────────
// AUTH MIDDLEWARE
// ─────────────────────────────────────────
function auth(req, res, next) {
  const token = req.headers.authorization?.replace("Bearer ", "");
  if (!token) return res.status(401).json({ message: "No token" });
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.userId = decoded.id;
    next();
  } catch {
    res.status(401).json({ message: "Invalid token" });
  }
}

// ─────────────────────────────────────────
// AUTH — REGISTER
// ─────────────────────────────────────────
app.post("/api/register", async (req, res) => {
  try {
    const { name, email, password, traumaType, traumaDate, traumaDescription } = req.body;

    // Check if email already exists
    const existing = await db.collection("users").where("email", "==", email).get();
    if (!existing.empty) {
      return res.status(400).json({ message: "Email already registered" });
    }

    const hashed = await bcrypt.hash(password, 10);
    const userRef = db.collection("users").doc();
    const userData = {
      name,
      email,
      password: hashed,
      traumaType: traumaType || "Something else",
      traumaDate: traumaDate || null,
      traumaDescription: traumaDescription || "",
      distressScore: null,
      createdAt: new Date().toISOString(),
    };

    await userRef.set(userData);

    const token = jwt.sign({ id: userRef.id }, process.env.JWT_SECRET);
    const { password: _, ...safeUser } = userData;
    res.json({ token, user: { id: userRef.id, ...safeUser } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Registration failed" });
  }
});

// ─────────────────────────────────────────
// AUTH — LOGIN
// ─────────────────────────────────────────
app.post("/api/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    const snapshot = await db.collection("users").where("email", "==", email).get();
    if (snapshot.empty) return res.status(400).json({ message: "User not found" });

    const userDoc = snapshot.docs[0];
    const userData = userDoc.data();

    const valid = await bcrypt.compare(password, userData.password);
    if (!valid) return res.status(400).json({ message: "Invalid password" });

    const token = jwt.sign({ id: userDoc.id }, process.env.JWT_SECRET);
    const { password: _, ...safeUser } = userData;
    res.json({ token, user: { id: userDoc.id, ...safeUser } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Login failed" });
  }
});

// ─────────────────────────────────────────
// AUTH — GET CURRENT USER
// ─────────────────────────────────────────
app.get("/api/me", auth, async (req, res) => {
  try {
    const userDoc = await db.collection("users").doc(req.userId).get();
    if (!userDoc.exists) return res.status(404).json({ message: "User not found" });
    const { password: _, ...safeUser } = userDoc.data();
    res.json({ id: userDoc.id, ...safeUser });
  } catch (err) {
    res.status(500).json({ message: "Could not fetch user" });
  }
});

// ─────────────────────────────────────────
// DAILY CHECK-IN — 10 answers → distress score
// ─────────────────────────────────────────
app.post("/api/checkin", auth, async (req, res) => {
  try {
    const { answers } = req.body;

    if (!Array.isArray(answers) || answers.length !== 10) {
      return res.status(400).json({ message: "Provide exactly 10 answers" });
    }

    const score = Math.round(
      answers.reduce((sum, v) => sum + Number(v), 0) / answers.length
    );

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const dateKey = today.toISOString().split("T")[0]; // e.g. "2024-02-22"

    const checkinRef = db
      .collection("users")
      .doc(req.userId)
      .collection("checkins")
      .doc(dateKey);

    await checkinRef.set({ answers, score, date: dateKey });

    // Update distress score on user
    await db.collection("users").doc(req.userId).update({ distressScore: score });

    res.json({ score, date: dateKey });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Check-in failed" });
  }
});

// ─────────────────────────────────────────
// WEEKLY PROGRESS — last 7 days
// ─────────────────────────────────────────
app.get("/api/progress", auth, async (req, res) => {
  try {
    const dates = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      d.setHours(0, 0, 0, 0);
      dates.push(d.toISOString().split("T")[0]);
    }

    const checkinsRef = db.collection("users").doc(req.userId).collection("checkins");
    const snapshot = await checkinsRef.where("date", "in", dates).get();

    const scores = snapshot.docs.map((doc) => ({
      date: doc.data().date,
      score: doc.data().score,
    })).sort((a, b) => a.date.localeCompare(b.date));

    const average =
      scores.length > 0
        ? Math.round(scores.reduce((s, c) => s + c.score, 0) / scores.length)
        : null;

    const best = scores.length > 0 ? Math.min(...scores.map((c) => c.score)) : null;

    // Streak: consecutive days ending today
    let streak = 0;
    for (let i = 0; i < dates.length; i++) {
      const day = dates[dates.length - 1 - i];
      if (scores.find((s) => s.date === day)) streak++;
      else break;
    }

    res.json({ scores, average, best, streak });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Could not fetch progress" });
  }
});

// ─────────────────────────────────────────
// TODAY'S SUMMARY
// ─────────────────────────────────────────
app.get("/api/summary", auth, async (req, res) => {
  try {
    const userDoc = await db.collection("users").doc(req.userId).get();
    const user = userDoc.data();

    const today = new Date().toISOString().split("T")[0];
    const checkinDoc = await db
      .collection("users")
      .doc(req.userId)
      .collection("checkins")
      .doc(today)
      .get();

    res.json({
      score: checkinDoc.exists ? checkinDoc.data().score : null,
      traumaType: user.traumaType,
      hasCheckedInToday: checkinDoc.exists,
    });
  } catch (err) {
    res.status(500).json({ message: "Could not fetch summary" });
  }
});

// ─────────────────────────────────────────
// JOURNAL
// ─────────────────────────────────────────
const JOURNAL_PROMPTS = [
  "What is one small thing that brought you comfort today?",
  "Describe a moment today when you felt safe.",
  "What emotion has been most present for you today, and where do you feel it in your body?",
  "Write about someone or something you are grateful for.",
  "What is one thing you would tell your past self right now?",
  "What does healing look like for you today?",
  "What boundaries did you honor today — or wish you had?",
  "Describe a sound, smell, or texture that felt soothing recently.",
  "What does your body need most right now?",
  "Write freely for 5 minutes — whatever comes up, without editing.",
];

app.get("/api/journal/prompt", auth, (req, res) => {
  const dayOfYear = Math.floor(
    (Date.now() - new Date(new Date().getFullYear(), 0, 0)) / 86400000
  );
  const prompt = JOURNAL_PROMPTS[dayOfYear % JOURNAL_PROMPTS.length];
  res.json({ prompt });
});

app.get("/api/journal", auth, async (req, res) => {
  try {
    const snapshot = await db
      .collection("users")
      .doc(req.userId)
      .collection("journal")
      .orderBy("date", "desc")
      .get();

    const entries = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
    res.json(entries);
  } catch (err) {
    res.status(500).json({ message: "Could not fetch journal" });
  }
});

app.post("/api/journal", auth, async (req, res) => {
  try {
    const { text, prompt } = req.body;
    const today = new Date().toISOString().split("T")[0];

    const entryRef = db
      .collection("users")
      .doc(req.userId)
      .collection("journal")
      .doc(today);

    await entryRef.set({ text, prompt, date: today });
    res.json({ id: today, text, prompt, date: today });
  } catch (err) {
    res.status(500).json({ message: "Could not save journal entry" });
  }
});

// ─────────────────────────────────────────
// PEER CIRCLES — online counts
// ─────────────────────────────────────────
const CIRCLES = [
  { id: "accident", name: "Accident Survivors Circle", traumaType: "Accident" },
  { id: "disaster", name: "Natural Disaster Support", traumaType: "Natural Disaster" },
  { id: "veterans", name: "Veterans & Service Members", traumaType: "War / Military" },
  { id: "medical", name: "Medical Trauma Circle", traumaType: "Medical Trauma" },
];

app.get("/api/circles", auth, async (req, res) => {
  try {
    const today = new Date().toISOString().split("T")[0];

    const results = await Promise.all(
      CIRCLES.map(async (circle) => {
        const usersSnap = await db
          .collection("users")
          .where("traumaType", "==", circle.traumaType)
          .get();

        let onlineCount = 0;
        for (const userDoc of usersSnap.docs) {
          const checkin = await db
            .collection("users")
            .doc(userDoc.id)
            .collection("checkins")
            .doc(today)
            .get();
          if (checkin.exists) onlineCount++;
        }

        // Fallback to a realistic number if no real data yet
        return {
          ...circle,
          onlineCount: onlineCount || Math.floor(Math.random() * 10 + 3),
        };
      })
    );

    res.json(results);
  } catch (err) {
    res.status(500).json({ message: "Could not fetch circles" });
  }
});

// ─────────────────────────────────────────
// START
// ─────────────────────────────────────────
app.listen(process.env.PORT || 5000, () =>
  console.log(`AfterStorm server running on port ${process.env.PORT || 5000}`)
);
