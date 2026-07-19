export type QuizDifficulty = 'recall' | 'application' | 'trap';

export interface QuizQuestion {
  id: string;
  prompt: string;
  options: [string, string, string, string];
  correctIndex: number;
  explanation: string;
  sourceAnchor: string;
  difficulty: QuizDifficulty;
}

export interface ChapterQuiz {
  chapter: number;
  slug: string;
  title: string;
  targetCount: number;
  questions: QuizQuestion[];
}

export interface SavedAnswer {
  selected: number;
  correct: boolean;
}

export interface ChapterProgress {
  currentIndex: number;
  answers: Record<string, SavedAnswer>;
  bestScore: number;
  completed: boolean;
}

export interface BookProgress {
  version: 1;
  lastRead?: string;
  chapters: Record<string, ChapterProgress>;
}

export const STORAGE_KEY = 'llcpp-book:v1:progress';

export function emptyProgress(): BookProgress {
  return { version: 1, chapters: {} };
}

export function readProgress(): BookProgress {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return emptyProgress();
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      (parsed as { version?: unknown }).version !== 1 ||
      typeof (parsed as { chapters?: unknown }).chapters !== 'object'
    ) return emptyProgress();
    return parsed as BookProgress;
  } catch {
    return emptyProgress();
  }
}

export function writeProgress(progress: BookProgress): boolean {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(progress));
    return true;
  } catch {
    return false;
  }
}
