import {
  collection,
  doc,
  setDoc,
  getDoc,
  getDocs,
  updateDoc,
  deleteDoc,
  onSnapshot,
  query,
  orderBy,
  Unsubscribe,
} from 'firebase/firestore';
import { db, auth } from './firebase';
import {
  StudentExamSession,
  ExamSettings,
  EssayRubricScore,
  StudentAnswer,
  TabViolation,
} from '../types/cbt';
import { calculateExamScores } from './scoring';
import { DEFAULT_SETTINGS, seedRealisticDemoSubmissions } from './storage';

export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: {
      providerId?: string | null;
      email?: string | null;
    }[];
  };
}

export function handleFirestoreError(
  error: unknown,
  operationType: OperationType,
  path: string | null
): never {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo:
        auth.currentUser?.providerData?.map((provider) => ({
          providerId: provider.providerId,
          email: provider.email,
        })) || [],
    },
    operationType,
    path,
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(errInfo.error);
}

const SESSIONS_COLLECTION = 'sessions';
const SETTINGS_COLLECTION = 'settings';
const SETTINGS_DOC_ID = 'exam_settings';

/**
 * Fetch settings from Firestore
 */
export async function fsGetSettings(): Promise<ExamSettings> {
  const path = `${SETTINGS_COLLECTION}/${SETTINGS_DOC_ID}`;
  try {
    const snap = await getDoc(doc(db, SETTINGS_COLLECTION, SETTINGS_DOC_ID));
    if (snap.exists()) {
      return { ...DEFAULT_SETTINGS, ...snap.data() } as ExamSettings;
    }
    return DEFAULT_SETTINGS;
  } catch (err) {
    handleFirestoreError(err, OperationType.GET, path);
  }
}

/**
 * Save settings to Firestore
 */
export async function fsSaveSettings(settings: ExamSettings): Promise<void> {
  const path = `${SETTINGS_COLLECTION}/${SETTINGS_DOC_ID}`;
  try {
    await setDoc(doc(db, SETTINGS_COLLECTION, SETTINGS_DOC_ID), settings, {
      merge: true,
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, path);
  }
}

/**
 * Check if a student with participantNumber has already completed the exam
 */
export async function fsCheckStudentRetake(
  participantNumber: string
): Promise<{ hasCompleted: boolean; studentName?: string }> {
  try {
    const snap = await getDocs(collection(db, SESSIONS_COLLECTION));
    const target = snap.docs
      .map((d) => d.data() as StudentExamSession)
      .find(
        (s) =>
          s.participantNumber?.trim().toLowerCase() ===
            participantNumber.trim().toLowerCase() &&
          s.status !== 'in-progress'
      );
    if (target) {
      return { hasCompleted: true, studentName: target.studentName };
    }
    return { hasCompleted: false };
  } catch (err) {
    console.warn('Could not check retake on Firestore, proceeding with local check:', err);
    return { hasCompleted: false };
  }
}

/**
 * Start or resume an exam session in Firestore
 */
export async function fsStartSession(info: {
  name: string;
  studentClass: string;
  participantNumber: string;
  examCode?: string;
}): Promise<StudentExamSession> {
  const trimmedNum = info.participantNumber.trim();
  const trimmedName = info.name.trim();
  const trimmedClass = info.studentClass.trim();

  // Check if an in-progress session already exists to resume
  try {
    const snap = await getDocs(collection(db, SESSIONS_COLLECTION));
    const existing = snap.docs
      .map((d) => d.data() as StudentExamSession)
      .find(
        (s) =>
          s.participantNumber?.trim().toLowerCase() ===
            trimmedNum.toLowerCase() && s.status === 'in-progress'
      );
    if (existing) {
      return existing;
    }
  } catch (e) {
    console.warn('Query existing in-progress notice:', e);
  }

  // Create new session document
  const sessionId = `cbt-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
  const sessionDocPath = `${SESSIONS_COLLECTION}/${sessionId}`;

  const newSession: StudentExamSession = {
    id: sessionId,
    studentName: trimmedName,
    studentClass: trimmedClass,
    participantNumber: trimmedNum,
    examCode: info.examCode || '',
    startTime: new Date().toISOString(),
    status: 'in-progress',
    answers: {},
    reviewFlags: {},
    tabViolations: [],
    scores: calculateExamScores({}),
  };

  try {
    await setDoc(doc(db, SESSIONS_COLLECTION, sessionId), newSession);
    return newSession;
  } catch (err) {
    handleFirestoreError(err, OperationType.CREATE, sessionDocPath);
  }
}

/**
 * Realtime progress save to Firestore
 */
export async function fsSaveProgress(
  sessionId: string,
  payload: {
    answers?: Record<number, StudentAnswer>;
    reviewFlags?: Record<number, boolean>;
    tabViolations?: TabViolation[];
  }
): Promise<boolean> {
  const path = `${SESSIONS_COLLECTION}/${sessionId}`;
  try {
    const docRef = doc(db, SESSIONS_COLLECTION, sessionId);
    await updateDoc(docRef, {
      ...(payload.answers ? { answers: payload.answers } : {}),
      ...(payload.reviewFlags ? { reviewFlags: payload.reviewFlags } : {}),
      ...(payload.tabViolations ? { tabViolations: payload.tabViolations } : {}),
    });
    return true;
  } catch (err) {
    console.warn('Realtime sync to Firestore notice:', err);
    return false;
  }
}

/**
 * Final submit of exam session to Firestore
 */
export async function fsSubmitSession(
  sessionId: string,
  payload: {
    answers: Record<number, StudentAnswer>;
    tabViolations: TabViolation[];
    status: 'submitted' | 'auto-time' | 'auto-tab-violation';
    statusReason?: string;
  }
): Promise<StudentExamSession> {
  const path = `${SESSIONS_COLLECTION}/${sessionId}`;
  const finishTime = new Date().toISOString();

  try {
    const docRef = doc(db, SESSIONS_COLLECTION, sessionId);
    const snap = await getDoc(docRef);

    const existingData = snap.exists() ? (snap.data() as StudentExamSession) : null;
    const startMs = existingData ? new Date(existingData.startTime).getTime() : Date.now();
    const usedSeconds = Math.max(0, Math.floor((Date.now() - startMs) / 1000));

    const calculatedScores = calculateExamScores(
      payload.answers,
      existingData?.scores?.essayRubrics
    );

    const submissionUpdate = {
      finishTime,
      durationSecondsUsed: usedSeconds,
      status: payload.status,
      statusReason: payload.statusReason || (payload.status === 'submitted' ? 'Diselesaikan secara mandiri oleh murid' : payload.statusReason),
      answers: payload.answers,
      tabViolations: payload.tabViolations,
      scores: calculatedScores,
    };

    await updateDoc(docRef, submissionUpdate);

    return {
      ...(existingData || ({} as any)),
      ...submissionUpdate,
      id: sessionId,
    };
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, path);
  }
}

/**
 * Fetch all sessions from Firestore once
 */
export async function fsGetAllSessions(): Promise<StudentExamSession[]> {
  const path = SESSIONS_COLLECTION;
  try {
    const snap = await getDocs(collection(db, SESSIONS_COLLECTION));
    return snap.docs.map((d) => d.data() as StudentExamSession);
  } catch (err) {
    handleFirestoreError(err, OperationType.LIST, path);
  }
}

/**
 * Subscribe to realtime updates for all student sessions (for Teacher Dashboard)
 */
export function fsSubscribeAllSessions(
  onUpdate: (sessions: StudentExamSession[]) => void,
  onError?: (err: Error) => void
): Unsubscribe {
  const path = SESSIONS_COLLECTION;
  return onSnapshot(
    collection(db, SESSIONS_COLLECTION),
    (snapshot) => {
      const list = snapshot.docs.map((d) => d.data() as StudentExamSession);
      onUpdate(list);
    },
    (error) => {
      console.warn('Firestore onSnapshot listener notice:', error);
      if (onError) {
        onError(error instanceof Error ? error : new Error(String(error)));
      }
    }
  );
}

/**
 * Update teacher essay rubric for question 9 or 10 in Firestore
 */
export async function fsUpdateEssayRubric(
  sessionId: string,
  questionId: number,
  rubric: EssayRubricScore
): Promise<StudentExamSession | null> {
  const path = `${SESSIONS_COLLECTION}/${sessionId}`;
  try {
    const docRef = doc(db, SESSIONS_COLLECTION, sessionId);
    const snap = await getDoc(docRef);
    if (!snap.exists()) return null;

    const data = snap.data() as StudentExamSession;
    const currentRubrics = data.scores.essayRubrics || {
      9: { identifikasi: 0, model: 0, hitungan: 0, penalaran: 0, kesimpulan: 0 },
      10: { identifikasi: 0, model: 0, hitungan: 0, penalaran: 0, kesimpulan: 0 },
    };

    currentRubrics[questionId] = rubric;
    const recalculated = calculateExamScores(data.answers, currentRubrics);

    await updateDoc(docRef, {
      scores: recalculated,
    });

    return { ...data, scores: recalculated };
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, path);
  }
}

/**
 * Reset student session for retake in Firestore
 */
export async function fsResetStudentForRetake(
  participantNumber: string
): Promise<void> {
  try {
    const snap = await getDocs(collection(db, SESSIONS_COLLECTION));
    const toDelete = snap.docs.filter(
      (d) =>
        (d.data() as StudentExamSession).participantNumber?.trim().toLowerCase() ===
        participantNumber.trim().toLowerCase()
    );
    for (const d of toDelete) {
      await deleteDoc(d.ref);
    }
  } catch (err) {
    handleFirestoreError(err, OperationType.DELETE, SESSIONS_COLLECTION);
  }
}

/**
 * Clear all sessions in Firestore
 */
export async function fsClearAllSessions(): Promise<void> {
  try {
    const snap = await getDocs(collection(db, SESSIONS_COLLECTION));
    for (const d of snap.docs) {
      await deleteDoc(d.ref);
    }
  } catch (err) {
    handleFirestoreError(err, OperationType.DELETE, SESSIONS_COLLECTION);
  }
}

/**
 * Seed demo student submissions to Firestore
 */
export async function fsSeedDemoData(): Promise<StudentExamSession[]> {
  const demoList = seedRealisticDemoSubmissions();
  try {
    for (const s of demoList) {
      await setDoc(doc(db, SESSIONS_COLLECTION, s.id), s);
    }
    return demoList;
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, SESSIONS_COLLECTION);
  }
}
