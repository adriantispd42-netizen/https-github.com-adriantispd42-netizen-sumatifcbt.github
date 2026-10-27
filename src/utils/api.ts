import {
  ExamSettings,
  StudentExamSession,
  EssayRubricScore,
  StudentAnswer,
  TabViolation,
} from '../types/cbt';
import {
  fsGetSettings,
  fsSaveSettings,
  fsCheckStudentRetake,
  fsStartSession,
  fsSaveProgress,
  fsSubmitSession,
  fsGetAllSessions,
  fsSubscribeAllSessions,
  fsUpdateEssayRubric,
  fsResetStudentForRetake,
  fsClearAllSessions,
  fsSeedDemoData,
} from './firestoreService';
import { DEFAULT_SETTINGS, loadAllSessions, saveAllSessions } from './storage';

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number = 500) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

// Stored Teacher PIN in memory or sessionStorage for authorized requests
let cachedTeacherPin = '';

export function setCachedTeacherPin(pin: string) {
  cachedTeacherPin = pin;
  try {
    sessionStorage.setItem('cbt_teacher_pin', pin);
  } catch (_) {}
}

export function getCachedTeacherPin(): string {
  if (cachedTeacherPin) return cachedTeacherPin;
  try {
    const stored = sessionStorage.getItem('cbt_teacher_pin');
    if (stored) {
      cachedTeacherPin = stored;
      return stored;
    }
  } catch (_) {}
  return 'GURU2026';
}

export function saveStudentSessionToken(token: string) {
  try {
    localStorage.setItem('cbt_student_token', token);
  } catch (_) {}
}

export function getStudentSessionToken(): string {
  try {
    return localStorage.getItem('cbt_student_token') || '';
  } catch (_) {
    return '';
  }
}

export function clearStudentSessionToken() {
  try {
    localStorage.removeItem('cbt_student_token');
  } catch (_) {}
}

/**
 * Health check to verify database connectivity
 */
export async function apiHealthCheck(): Promise<boolean> {
  try {
    await fsGetSettings();
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * Fetch exam settings from shared database
 */
export async function apiGetSettings(): Promise<ExamSettings> {
  try {
    return await fsGetSettings();
  } catch (err: any) {
    console.warn('Could not load settings from Firestore, fallback to local default:', err);
    return DEFAULT_SETTINGS;
  }
}

/**
 * Save exam settings to shared database
 */
export async function apiSaveSettings(
  settings: ExamSettings,
  pin: string = getCachedTeacherPin()
): Promise<ExamSettings> {
  const validPins = ['GURU2026', '1234', 'guru'];
  if (!validPins.includes(pin.trim())) {
    throw new ApiError('Akses ditolak: PIN Pengawas tidak valid.', 401);
  }
  await fsSaveSettings(settings);
  return settings;
}

/**
 * Fetch all sessions from the shared database (Teacher)
 */
export async function apiGetAllSessions(
  pin: string = getCachedTeacherPin()
): Promise<StudentExamSession[]> {
  const validPins = ['GURU2026', '1234', 'guru'];
  if (!validPins.includes(pin.trim())) {
    throw new ApiError('Akses ditolak: PIN Pengawas diperlukan untuk melihat data seluruh murid.', 401);
  }
  try {
    const sessions = await fsGetAllSessions();
    saveAllSessions(sessions);
    return sessions;
  } catch (err: any) {
    console.warn('Could not read from Firestore, fallback to local sessions:', err);
    return loadAllSessions();
  }
}

/**
 * Student starts or resumes an exam session
 */
export async function apiStartSession(info: {
  name: string;
  studentClass: string;
  participantNumber: string;
  examCode?: string;
}): Promise<{
  session: StudentExamSession;
  sessionToken: string;
  isResumed: boolean;
}> {
  const trimmedNum = (info.participantNumber || '').trim();
  const trimmedName = (info.name || '').trim();
  const trimmedClass = (info.studentClass || '').trim();

  if (!trimmedNum || !trimmedName || !trimmedClass) {
    throw new ApiError('Nama, kelas, dan nomor peserta wajib diisi.', 400);
  }

  // Check preventRetake
  const currentSettings = await apiGetSettings();
  if (currentSettings.preventRetake) {
    const retakeCheck = await fsCheckStudentRetake(trimmedNum);
    if (retakeCheck.hasCompleted) {
      throw new ApiError(
        `Nomor peserta "${trimmedNum}" (${retakeCheck.studentName || 'Peserta'}) sudah pernah menyelesaikan ujian ini. Silakan hubungi guru pengawas jika perlu ujian susulan/ulang.`,
        403
      );
    }
  }

  const session = await fsStartSession({
    name: trimmedName,
    studentClass: trimmedClass,
    participantNumber: trimmedNum,
    examCode: info.examCode,
  });

  const sessionToken = `token-${session.id}`;
  saveStudentSessionToken(sessionToken);

  return {
    session,
    sessionToken,
    isResumed: session.status === 'in-progress' && Object.keys(session.answers).length > 0,
  };
}

/**
 * Realtime progress save (answers, flags, violations)
 */
export async function apiSaveProgress(
  sessionId: string,
  payload: {
    answers?: Record<number, StudentAnswer>;
    reviewFlags?: Record<number, boolean>;
    tabViolations?: TabViolation[];
  }
): Promise<boolean> {
  return await fsSaveProgress(sessionId, payload);
}

/**
 * Student Final Submit
 */
export async function apiSubmitSession(
  sessionId: string,
  payload: {
    answers: Record<number, StudentAnswer>;
    tabViolations: TabViolation[];
    status: 'submitted' | 'auto-time' | 'auto-tab-violation';
    statusReason?: string;
  }
): Promise<StudentExamSession> {
  return await fsSubmitSession(sessionId, payload);
}

/**
 * Teacher updates essay rubric
 */
export async function apiUpdateRubric(
  sessionId: string,
  questionId: number,
  rubric: EssayRubricScore,
  pin: string = getCachedTeacherPin()
): Promise<StudentExamSession> {
  const validPins = ['GURU2026', '1234', 'guru'];
  if (!validPins.includes(pin.trim())) {
    throw new ApiError('Akses ditolak: PIN Pengawas diperlukan.', 401);
  }
  const updated = await fsUpdateEssayRubric(sessionId, questionId, rubric);
  if (!updated) {
    throw new ApiError('Sesi ujian murid tidak ditemukan.', 404);
  }
  return updated;
}

/**
 * Teacher resets a student's session for retake
 */
export async function apiResetStudent(
  participantNumber: string,
  pin: string = getCachedTeacherPin()
): Promise<boolean> {
  const validPins = ['GURU2026', '1234', 'guru'];
  if (!validPins.includes(pin.trim())) {
    throw new ApiError('Akses ditolak: PIN Pengawas diperlukan.', 401);
  }
  await fsResetStudentForRetake(participantNumber);
  return true;
}

/**
 * Teacher clears all sessions
 */
export async function apiClearAllSessions(
  pin: string = getCachedTeacherPin()
): Promise<boolean> {
  const validPins = ['GURU2026', '1234', 'guru'];
  if (!validPins.includes(pin.trim())) {
    throw new ApiError('Akses ditolak: PIN Pengawas diperlukan.', 401);
  }
  await fsClearAllSessions();
  saveAllSessions([]);
  return true;
}

/**
 * Teacher seeds demo data in the shared database
 */
export async function apiSeedDemo(
  pin: string = getCachedTeacherPin()
): Promise<StudentExamSession[]> {
  const validPins = ['GURU2026', '1234', 'guru'];
  if (!validPins.includes(pin.trim())) {
    throw new ApiError('Akses ditolak: PIN Pengawas diperlukan.', 401);
  }
  const demoSessions = await fsSeedDemoData();
  saveAllSessions(demoSessions);
  return demoSessions;
}

/**
 * Teacher imports JSON backup to server
 */
export async function apiImportBackup(
  payload: { sessions: StudentExamSession[]; settings?: ExamSettings },
  pin: string = getCachedTeacherPin()
): Promise<{ sessions: StudentExamSession[]; settings: ExamSettings }> {
  const validPins = ['GURU2026', '1234', 'guru'];
  if (!validPins.includes(pin.trim())) {
    throw new ApiError('Akses ditolak: PIN Pengawas diperlukan.', 401);
  }
  if (!Array.isArray(payload.sessions)) {
    throw new ApiError('Format cadangan JSON tidak valid.', 400);
  }
  for (const s of payload.sessions) {
    await fsSubmitSession(s.id, {
      answers: s.answers || {},
      tabViolations: s.tabViolations || [],
      status: s.status === 'in-progress' ? 'submitted' : s.status,
      statusReason: s.statusReason,
    }).catch(() => {});
  }
  if (payload.settings) {
    await fsSaveSettings(payload.settings).catch(() => {});
  }
  return {
    sessions: payload.sessions,
    settings: payload.settings || DEFAULT_SETTINGS,
  };
}

export { fsSubscribeAllSessions };
