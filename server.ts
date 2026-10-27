import express, { Request, Response } from 'express';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import fs from 'fs';
import { calculateExamScores } from './src/utils/scoring.ts';
import { DEFAULT_SETTINGS, seedRealisticDemoSubmissions } from './src/utils/storage.ts';
import { ExamSettings, StudentExamSession, EssayRubricScore } from './src/types/cbt.ts';

const app = express();
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
const isProd = process.env.NODE_ENV === 'production';

// Ensure data directory exists
const DATA_DIR = path.resolve(process.cwd(), 'data');
const DB_FILE = path.join(DATA_DIR, 'cbt_database.json');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

interface DatabaseState {
  settings: ExamSettings;
  sessions: (StudentExamSession & { sessionToken?: string })[];
}

function loadDatabase(): DatabaseState {
  try {
    if (fs.existsSync(DB_FILE)) {
      const raw = fs.readFileSync(DB_FILE, 'utf-8');
      const parsed = JSON.parse(raw);
      return {
        settings: { ...DEFAULT_SETTINGS, ...(parsed.settings || {}) },
        sessions: Array.isArray(parsed.sessions) ? parsed.sessions : [],
      };
    }
  } catch (err) {
    console.error('Error reading database file, initializing default:', err);
  }
  return {
    settings: { ...DEFAULT_SETTINGS },
    sessions: [],
  };
}

let dbCache: DatabaseState = loadDatabase();

function saveDatabase(): void {
  try {
    const tempFile = `${DB_FILE}.tmp`;
    fs.writeFileSync(tempFile, JSON.stringify(dbCache, null, 2), 'utf-8');
    fs.renameSync(tempFile, DB_FILE);
  } catch (err) {
    console.error('Error saving database file:', err);
  }
}

// Teacher PIN verification helper
function verifyTeacherPin(req: Request): boolean {
  const pinHeader = req.headers['x-teacher-pin'];
  const pinQuery = req.query.pin;
  const pin = (typeof pinHeader === 'string' ? pinHeader : typeof pinQuery === 'string' ? pinQuery : '').trim();
  const validPins = ['GURU2026', '1234', 'guru'];
  return validPins.includes(pin);
}

app.use(express.json({ limit: '10mb' }));

// -------------------------------------------------------------
// API Endpoints
// -------------------------------------------------------------

// Health check
app.get('/api/health', (_req: Request, res: Response) => {
  res.json({
    status: 'ok',
    serverTime: new Date().toISOString(),
    totalSessions: dbCache.sessions.length,
  });
});

// GET Settings
app.get('/api/settings', (_req: Request, res: Response) => {
  res.json({
    success: true,
    settings: dbCache.settings,
  });
});

// POST Settings (Teacher only)
app.post('/api/settings', (req: Request, res: Response) => {
  if (!verifyTeacherPin(req)) {
    res.status(401).json({ success: false, error: 'Akses ditolak: PIN Pengawas diperlukan.' });
    return;
  }
  const newSettings = req.body;
  if (!newSettings || typeof newSettings !== 'object') {
    res.status(400).json({ success: false, error: 'Format pengaturan tidak valid.' });
    return;
  }
  dbCache.settings = {
    ...dbCache.settings,
    ...newSettings,
  };
  saveDatabase();
  res.json({ success: true, settings: dbCache.settings });
});

// GET All Sessions (Teacher only)
app.get('/api/sessions', (req: Request, res: Response) => {
  if (!verifyTeacherPin(req)) {
    res.status(401).json({ success: false, error: 'Akses ditolak: PIN Pengawas diperlukan untuk melihat data seluruh murid.' });
    return;
  }
  // Return all sessions with latest calculation
  res.json({
    success: true,
    sessions: dbCache.sessions,
  });
});

// POST Student Start Exam Session
app.post('/api/sessions/start', (req: Request, res: Response) => {
  const { name, studentClass, participantNumber, examCode } = req.body || {};
  const trimmedName = (name || '').trim();
  const trimmedClass = (studentClass || '').trim();
  const trimmedNum = (participantNumber || '').trim();

  if (!trimmedName || !trimmedClass || !trimmedNum) {
    res.status(400).json({ success: false, error: 'Nama lengkap, kelas, dan nomor peserta wajib diisi.' });
    return;
  }

  // Check preventRetake
  if (dbCache.settings.preventRetake) {
    const existingCompleted = dbCache.sessions.find(
      (s) => s.participantNumber.toLowerCase() === trimmedNum.toLowerCase() && s.status !== 'in-progress'
    );
    if (existingCompleted) {
      res.status(403).json({
        success: false,
        error: `Nomor peserta "${trimmedNum}" (${existingCompleted.studentName}) sudah menyelesaikan ujian. Silakan hubungi guru pengawas jika perlu ujian susulan/ulang.`,
      });
      return;
    }
  }

  // Check if there is an in-progress session for this student to resume
  const existingInProgress = dbCache.sessions.find(
    (s) => s.participantNumber.toLowerCase() === trimmedNum.toLowerCase() && s.status === 'in-progress'
  );

  if (existingInProgress) {
    res.json({
      success: true,
      isResumed: true,
      session: existingInProgress,
      sessionToken: existingInProgress.sessionToken,
    });
    return;
  }

  // Generate new session & secret session token
  const sessionId = `cbt-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
  const sessionToken = `token-${Date.now()}-${Math.random().toString(36).substring(2, 10)}`;

  const newSession: StudentExamSession & { sessionToken: string } = {
    id: sessionId,
    sessionToken,
    studentName: trimmedName,
    studentClass: trimmedClass,
    participantNumber: trimmedNum,
    examCode: examCode || '',
    startTime: new Date().toISOString(),
    status: 'in-progress',
    answers: {},
    reviewFlags: {},
    tabViolations: [],
    scores: calculateExamScores({}),
  };

  dbCache.sessions.push(newSession);
  saveDatabase();

  res.json({
    success: true,
    isResumed: false,
    session: newSession,
    sessionToken,
  });
});

// PUT Student Save Progress (Realtime Auto-save)
app.put('/api/sessions/:id/progress', (req: Request, res: Response) => {
  const { id } = req.params;
  const token = req.headers['x-session-token'] || req.body?.sessionToken;

  const session = dbCache.sessions.find((s) => s.id === id);
  if (!session) {
    res.status(404).json({ success: false, error: 'Sesi ujian tidak ditemukan.' });
    return;
  }

  // Verify ownership
  if (session.sessionToken && session.sessionToken !== token) {
    res.status(403).json({ success: false, error: 'Akses ditolak: token sesi tidak valid.' });
    return;
  }

  // Do not overwrite if already submitted
  if (session.status !== 'in-progress') {
    res.json({ success: true, message: 'Sesi telah diserahkan sebelumnya.', session });
    return;
  }

  const { answers, reviewFlags, tabViolations } = req.body || {};
  if (answers) session.answers = answers;
  if (reviewFlags) session.reviewFlags = reviewFlags;
  if (tabViolations) session.tabViolations = tabViolations;

  saveDatabase();
  res.json({ success: true, savedAt: new Date().toISOString() });
});

// POST Student Final Submit
app.post('/api/sessions/:id/submit', (req: Request, res: Response) => {
  const { id } = req.params;
  const token = req.headers['x-session-token'] || req.body?.sessionToken;

  const session = dbCache.sessions.find((s) => s.id === id);
  if (!session) {
    res.status(404).json({ success: false, error: 'Sesi ujian tidak ditemukan.' });
    return;
  }

  if (session.sessionToken && session.sessionToken !== token) {
    res.status(403).json({ success: false, error: 'Akses ditolak: token sesi tidak valid.' });
    return;
  }

  const { answers, tabViolations, status = 'submitted', statusReason } = req.body || {};
  if (answers) session.answers = answers;
  if (tabViolations) session.tabViolations = tabViolations;

  const finishTime = new Date().toISOString();
  const startMs = new Date(session.startTime).getTime();
  const finishMs = new Date(finishTime).getTime();
  const usedSeconds = Math.max(0, Math.floor((finishMs - startMs) / 1000));

  // Compute final scores
  const calculatedScores = calculateExamScores(
    session.answers,
    session.scores?.essayRubrics
  );

  session.finishTime = finishTime;
  session.durationSecondsUsed = usedSeconds;
  session.status = status;
  session.statusReason = statusReason || (status === 'submitted' ? 'Diselesaikan secara mandiri oleh murid' : statusReason);
  session.scores = calculatedScores;

  saveDatabase();

  res.json({
    success: true,
    session,
  });
});

// GET Student Single Session (Student with token, or Teacher with PIN)
app.get('/api/sessions/:id', (req: Request, res: Response) => {
  const { id } = req.params;
  const session = dbCache.sessions.find((s) => s.id === id);
  if (!session) {
    res.status(404).json({ success: false, error: 'Sesi tidak ditemukan.' });
    return;
  }

  const isTeacher = verifyTeacherPin(req);
  const token = req.headers['x-session-token'];
  const isOwner = session.sessionToken && session.sessionToken === token;

  if (!isTeacher && !isOwner) {
    res.status(403).json({ success: false, error: 'Akses ditolak.' });
    return;
  }

  res.json({ success: true, session });
});

// PUT Teacher Update Essay Rubric
app.put('/api/sessions/:id/rubric', (req: Request, res: Response) => {
  if (!verifyTeacherPin(req)) {
    res.status(401).json({ success: false, error: 'Akses ditolak: PIN Pengawas diperlukan.' });
    return;
  }

  const { id } = req.params;
  const { questionId, rubric } = req.body || {};
  const qId = parseInt(questionId, 10);

  const session = dbCache.sessions.find((s) => s.id === id);
  if (!session) {
    res.status(404).json({ success: false, error: 'Sesi tidak ditemukan.' });
    return;
  }

  if (qId !== 9 && qId !== 10) {
    res.status(400).json({ success: false, error: 'Hanya soal uraian 9 dan 10 yang dapat dinilai menggunakan rubrik ini.' });
    return;
  }

  const currentRubrics = session.scores.essayRubrics || {
    9: { identifikasi: 0, model: 0, hitungan: 0, penalaran: 0, kesimpulan: 0 },
    10: { identifikasi: 0, model: 0, hitungan: 0, penalaran: 0, kesimpulan: 0 },
  };

  currentRubrics[qId] = rubric as EssayRubricScore;
  session.scores = calculateExamScores(session.answers, currentRubrics);

  saveDatabase();

  res.json({
    success: true,
    session,
  });
});

// POST Teacher Reset Student Session for Retake
app.post('/api/sessions/:participantNumber/reset', (req: Request, res: Response) => {
  if (!verifyTeacherPin(req)) {
    res.status(401).json({ success: false, error: 'Akses ditolak: PIN Pengawas diperlukan.' });
    return;
  }

  const { participantNumber } = req.params;
  const initialCount = dbCache.sessions.length;
  dbCache.sessions = dbCache.sessions.filter(
    (s) => s.participantNumber.toLowerCase() !== participantNumber.toLowerCase()
  );

  saveDatabase();

  res.json({
    success: true,
    removedCount: initialCount - dbCache.sessions.length,
    message: `Sesi murid dengan nomor peserta ${participantNumber} berhasil direset.`,
  });
});

// POST Teacher Clear All Data
app.post('/api/sessions/clear-all', (req: Request, res: Response) => {
  if (!verifyTeacherPin(req)) {
    res.status(401).json({ success: false, error: 'Akses ditolak: PIN Pengawas diperlukan.' });
    return;
  }

  dbCache.sessions = [];
  saveDatabase();

  res.json({
    success: true,
    message: 'Semua data sesi ujian berhasil dibersihkan.',
  });
});

// POST Teacher Seed Demo Submissions
app.post('/api/sessions/seed-demo', (req: Request, res: Response) => {
  if (!verifyTeacherPin(req)) {
    res.status(401).json({ success: false, error: 'Akses ditolak: PIN Pengawas diperlukan.' });
    return;
  }

  const demoSessions = seedRealisticDemoSubmissions();
  dbCache.sessions = demoSessions;
  saveDatabase();

  res.json({
    success: true,
    count: demoSessions.length,
    sessions: demoSessions,
  });
});

// POST Teacher Import Backup JSON
app.post('/api/sessions/import-backup', (req: Request, res: Response) => {
  if (!verifyTeacherPin(req)) {
    res.status(401).json({ success: false, error: 'Akses ditolak: PIN Pengawas diperlukan.' });
    return;
  }

  const { sessions, settings } = req.body || {};
  if (!Array.isArray(sessions)) {
    res.status(400).json({ success: false, error: 'Format data backup tidak valid.' });
    return;
  }

  dbCache.sessions = sessions;
  if (settings) {
    dbCache.settings = { ...DEFAULT_SETTINGS, ...settings };
  }
  saveDatabase();

  res.json({
    success: true,
    count: sessions.length,
    sessions: dbCache.sessions,
    settings: dbCache.settings,
  });
});

// -------------------------------------------------------------
// Vite Middleware / Static Frontend Serving
// -------------------------------------------------------------

async function startServer() {
  if (!isProd) {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req: Request, res: Response) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 CBT Server running on http://0.0.0.0:${PORT} (${isProd ? 'production' : 'development'})`);
  });
}

startServer();
