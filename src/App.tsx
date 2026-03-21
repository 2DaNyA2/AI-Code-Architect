/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useEffect, Component, ErrorInfo, ReactNode } from 'react';
import { GoogleGenAI, Type } from '@google/genai';
import { motion, AnimatePresence } from 'motion/react';
import { Loader2, Code2, FolderTree, Terminal, Rocket, Layers, FileCode2, Sparkles, LogOut, ShieldAlert, Lock, User as UserIcon } from 'lucide-react';
import { auth, db } from './firebase';
import { signInWithPopup, GoogleAuthProvider, signOut, onAuthStateChanged, User } from 'firebase/auth';
import { doc, getDoc, setDoc, updateDoc, onSnapshot } from 'firebase/firestore';

enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId: string | undefined;
    email: string | null | undefined;
    emailVerified: boolean | undefined;
    isAnonymous: boolean | undefined;
    tenantId: string | null | undefined;
    providerInfo: {
      providerId: string;
      displayName: string | null;
      email: string | null;
      photoUrl: string | null;
    }[];
  }
}

function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null, currentUser: User | null) {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: currentUser?.uid,
      email: currentUser?.email,
      emailVerified: currentUser?.emailVerified,
      isAnonymous: currentUser?.isAnonymous,
      tenantId: currentUser?.tenantId,
      providerInfo: currentUser?.providerData.map(provider => ({
        providerId: provider.providerId,
        displayName: provider.displayName,
        email: provider.email,
        photoUrl: provider.photoURL
      })) || []
    },
    operationType,
    path
  }
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

class ErrorBoundary extends Component<{children: ReactNode}, {hasError: boolean, error: Error | null}> {
  constructor(props: {children: ReactNode}) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error("Uncaught error:", error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen bg-[#0f1115] text-slate-300 flex flex-col items-center justify-center p-4">
          <ShieldAlert className="w-16 h-16 text-red-500 mb-4" />
          <h1 className="text-2xl font-bold text-white mb-2">Something went wrong</h1>
          <p className="text-slate-400 mb-6 text-center max-w-md">
            An error occurred while connecting to the database. Please try refreshing the page.
          </p>
          <button 
            onClick={() => window.location.reload()}
            className="px-6 py-2 bg-emerald-500 hover:bg-emerald-600 text-white rounded-xl font-medium transition-colors"
          >
            Refresh page
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

interface GeneratedProject {
  project_name: string;
  tech_stack: string[];
  file_structure: string;
  core_logic: {
    file_name: string;
    description: string;
    code_snippet: string;
  }[];
  setup_guide: string[];
}

interface UserProfile {
  uid: string;
  email: string;
  generationsToday: number;
  lastGenerationDate: string;
  subscriptionTier: 'free' | 'premium';
}

const DAILY_LIMIT = 5;

export default function AppWrapper() {
  return (
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  );
}

function App() {
  const [idea, setIdea] = useState('');
  const [loading, setLoading] = useState(false);
  const [project, setProject] = useState<GeneratedProject | null>(null);
  const [error, setError] = useState('');

  // Auth & Limits State
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [showSubscribeModal, setShowSubscribeModal] = useState(false);

  useEffect(() => {
    let unsubProfile: (() => void) | undefined;

    const unsubscribe = onAuthStateChanged(auth, async (currentUser) => {
      setUser(currentUser);
      
      if (unsubProfile) {
        unsubProfile();
        unsubProfile = undefined;
      }

      if (!currentUser) {
        setProfile(null);
        setAuthLoading(false);
        return;
      }

      // Check and create user profile if it doesn't exist
      const userRef = doc(db, 'users', currentUser.uid);
      try {
        const docSnap = await getDoc(userRef);
        const today = new Date().toISOString().split('T')[0];
        
        if (!docSnap.exists()) {
          const newProfile: UserProfile = {
            uid: currentUser.uid,
            email: currentUser.email || 'no-email@example.com',
            generationsToday: 0,
            lastGenerationDate: today,
            subscriptionTier: 'free'
          };
          await setDoc(userRef, newProfile);
        }
      } catch (err) {
        console.error("Error setting up user profile:", err);
        handleFirestoreError(err, OperationType.WRITE, `users/${currentUser.uid}`, currentUser);
      }

      // Listen to profile changes
      unsubProfile = onSnapshot(userRef, (doc) => {
        if (doc.exists()) {
          setProfile(doc.data() as UserProfile);
        }
        setAuthLoading(false);
      }, (error) => {
        handleFirestoreError(error, OperationType.GET, `users/${currentUser.uid}`, currentUser);
      });
    });

    return () => {
      unsubscribe();
      if (unsubProfile) {
        unsubProfile();
      }
    };
  }, []);

  const handleLogin = async () => {
    try {
      const provider = new GoogleAuthProvider();
      await signInWithPopup(auth, provider);
    } catch (err) {
      console.error("Login error:", err);
      setError("Login failed. Please try again.");
    }
  };

  const handleLogout = async () => {
    await signOut(auth);
    setProject(null);
    setIdea('');
  };

  const checkAndUpdateLimits = async (): Promise<boolean> => {
    if (!user || !profile) return false;
    
    const today = new Date().toISOString().split('T')[0];
    const userRef = doc(db, 'users', user.uid);
    
    try {
      let currentGenerations = profile.generationsToday;
      
      // Reset if it's a new day
      if (profile.lastGenerationDate !== today) {
        currentGenerations = 0;
      }

      // Check limit
      if (profile.subscriptionTier === 'free' && currentGenerations >= DAILY_LIMIT) {
        setShowSubscribeModal(true);
        return false;
      }

      // Update in Firestore
      await updateDoc(userRef, {
        generationsToday: currentGenerations + 1,
        lastGenerationDate: today
      });
      
      return true;
    } catch (err) {
      console.error("Error updating limits:", err);
      handleFirestoreError(err, OperationType.UPDATE, `users/${user.uid}`, user);
      setError("Error checking limits.");
      return false;
    }
  };

  const handleGenerate = async () => {
    if (!idea.trim() || !user) return;
    
    setLoading(true);
    setError('');
    
    // Check limits before generating
    const canGenerate = await checkAndUpdateLimits();
    if (!canGenerate) {
      setLoading(false);
      return;
    }
    
    try {
      // Initialize AI with platform key
      const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

      const prompt = `You are an expert software architect. Your task is to take a user's idea description and design a detailed technical documentation for the project.

Provide the response in JSON format containing the following fields:
project_name: name of the project.
tech_stack: list of recommended technologies.
file_structure: tree-like structure of folders and files.
core_logic: array of objects describing the code for 2-3 key files (file_name, description, code_snippet).
setup_guide: array of steps for deployment/setup.

Respond clearly, structurally, and technically accurately. The user wants to create: ${idea}`;

      const response = await ai.models.generateContent({
        model: 'gemini-flash-latest',
        contents: prompt,
        config: {
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              project_name: { type: Type.STRING },
              tech_stack: { type: Type.ARRAY, items: { type: Type.STRING } },
              file_structure: { type: Type.STRING },
              core_logic: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    file_name: { type: Type.STRING },
                    description: { type: Type.STRING },
                    code_snippet: { type: Type.STRING }
                  },
                  required: ["file_name", "description", "code_snippet"]
                }
              },
              setup_guide: { type: Type.ARRAY, items: { type: Type.STRING } }
            },
            required: ["project_name", "tech_stack", "file_structure", "core_logic", "setup_guide"]
          }
        }
      });

      if (response.text) {
        const parsed = JSON.parse(response.text) as GeneratedProject;
        setProject(parsed);
      } else {
        setError('Failed to generate response. Please try again.');
      }
    } catch (err: any) {
      console.error(err);
      setError(err.message || 'An error occurred during generation.');
    } finally {
      setLoading(false);
    }
  };

  if (authLoading) {
    return (
      <div className="min-h-screen bg-[#0f1115] flex items-center justify-center">
        <Loader2 className="w-8 h-8 text-emerald-500 animate-spin" />
      </div>
    );
  }

  // Calculate remaining generations
  const today = new Date().toISOString().split('T')[0];
  const currentGenerations = profile?.lastGenerationDate === today ? (profile?.generationsToday || 0) : 0;
  const remainingGenerations = Math.max(0, DAILY_LIMIT - currentGenerations);

  return (
    <div className="min-h-screen bg-[#0f1115] text-slate-300 font-sans selection:bg-emerald-500/30">
      {/* Subscribe Modal */}
      <AnimatePresence>
        {showSubscribeModal && (
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
          >
            <motion.div 
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              className="bg-[#16191f] border border-white/10 rounded-2xl p-6 max-w-md w-full shadow-2xl text-center"
            >
              <div className="w-16 h-16 bg-emerald-500/20 rounded-full flex items-center justify-center mx-auto mb-4">
                <Lock className="w-8 h-8 text-emerald-400" />
              </div>
              <h2 className="text-2xl font-semibold text-white mb-2">Limit Reached</h2>
              <p className="text-slate-400 mb-6">
                You have used all {DAILY_LIMIT} free generations for today. 
                Upgrade to Premium to get unlimited access!
              </p>
              
              <div className="bg-[#0f1115] border border-emerald-500/30 rounded-xl p-4 mb-6">
                <h3 className="text-emerald-400 font-medium mb-1">Premium Subscription</h3>
                <p className="text-2xl text-white font-bold mb-2">$9.99 <span className="text-sm text-slate-500 font-normal">/ month</span></p>
                <ul className="text-sm text-slate-400 space-y-2 text-left">
                  <li className="flex items-center gap-2"><Sparkles size={14} className="text-emerald-500"/> Unlimited generations</li>
                  <li className="flex items-center gap-2"><Sparkles size={14} className="text-emerald-500"/> Priority speed</li>
                  <li className="flex items-center gap-2"><Sparkles size={14} className="text-emerald-500"/> Access to new models</li>
                </ul>
              </div>

              <div className="flex gap-3">
                <button 
                  onClick={() => setShowSubscribeModal(false)}
                  className="flex-1 px-4 py-2.5 rounded-xl text-sm font-medium text-slate-300 hover:bg-white/5 transition-colors border border-white/10"
                >
                  Later
                </button>
                <button 
                  onClick={() => {
                    alert("Payment system integration (e.g., Stripe) will be here.");
                    setShowSubscribeModal(false);
                  }}
                  className="flex-1 px-4 py-2.5 bg-emerald-500 hover:bg-emerald-600 text-white rounded-xl text-sm font-medium transition-colors"
                >
                  Get Premium
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Login Overlay */}
      {!user && (
        <div className="fixed inset-0 z-40 bg-[#0f1115] flex flex-col items-center justify-center p-4">
          <div className="w-16 h-16 bg-emerald-500/20 rounded-2xl flex items-center justify-center mb-6">
            <Code2 className="w-8 h-8 text-emerald-400" />
          </div>
          <h1 className="text-3xl font-bold text-white mb-3 text-center">AI Code Architect</h1>
          <p className="text-slate-400 mb-8 max-w-md text-center">
            Sign in to generate architecture for your apps. You get {DAILY_LIMIT} free generations daily.
          </p>
          <button 
            onClick={handleLogin}
            className="flex items-center gap-3 px-6 py-3 bg-white text-black hover:bg-slate-200 rounded-xl font-medium transition-colors"
          >
            <svg className="w-5 h-5" viewBox="0 0 24 24">
              <path fill="currentColor" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" />
              <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
              <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" />
              <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" />
            </svg>
            Sign in with Google
          </button>
        </div>
      )}

      {/* Header */}
      <header className="border-b border-white/10 bg-[#16191f] sticky top-0 z-10">
        <div className="max-w-6xl mx-auto p-4 flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-emerald-500/20 flex items-center justify-center text-emerald-400">
              <Code2 size={20} />
            </div>
            <h1 className="text-xl font-semibold text-white tracking-tight">AI Code Architect</h1>
          </div>
          
          {user && profile && (
            <div className="flex items-center gap-4">
              <div className="hidden sm:flex items-center gap-2 text-sm">
                <span className="text-slate-400">Today:</span>
                <span className={`font-medium px-2 py-0.5 rounded ${profile.subscriptionTier === 'premium' ? 'bg-emerald-500/20 text-emerald-400' : remainingGenerations === 0 ? 'bg-red-500/20 text-red-400' : 'bg-white/10 text-white'}`}>
                  {profile.subscriptionTier === 'premium' ? 'Unlimited' : `${remainingGenerations} / ${DAILY_LIMIT}`}
                </span>
              </div>
              <div className="h-6 w-px bg-white/10 hidden sm:block"></div>
              <div className="flex items-center gap-3">
                <div className="flex items-center gap-2 text-sm text-slate-300">
                  {user.photoURL ? (
                    <img src={user.photoURL} alt="Avatar" className="w-6 h-6 rounded-full" referrerPolicy="no-referrer" />
                  ) : (
                    <UserIcon size={16} />
                  )}
                  <span className="hidden sm:inline">{user.displayName || user.email}</span>
                </div>
                <button 
                  onClick={handleLogout}
                  className="p-1.5 text-slate-400 hover:text-white hover:bg-white/5 rounded-lg transition-colors"
                  title="Sign out"
                >
                  <LogOut size={18} />
                </button>
              </div>
            </div>
          )}
        </div>
      </header>

      <main className="max-w-6xl mx-auto p-4 md:p-8 grid grid-cols-1 lg:grid-cols-12 gap-8">
        {/* Input Section */}
        <div className="lg:col-span-4 space-y-4">
          <div className="bg-[#16191f] rounded-2xl border border-white/5 p-5 shadow-xl sticky top-24">
            <h2 className="text-lg font-medium text-white mb-2 flex items-center gap-2">
              <Rocket size={18} className="text-emerald-400" />
              Describe your idea
            </h2>
            <p className="text-sm text-slate-400 mb-4">
              Tell us what app you want to build, and AI will generate the architecture for it.
            </p>
            <textarea
              value={idea}
              onChange={(e) => setIdea(e.target.value)}
              placeholder="For example: I want a clicker game in React with an upgrade system..."
              className="w-full h-40 bg-[#0f1115] border border-white/10 rounded-xl p-3 text-sm focus:outline-none focus:border-emerald-500/50 focus:ring-1 focus:ring-emerald-500/50 transition-all resize-none mb-4 text-slate-200 placeholder:text-slate-600"
            />
            <button
              onClick={handleGenerate}
              disabled={loading || !idea.trim() || (!profile || (profile.subscriptionTier === 'free' && remainingGenerations <= 0))}
              className="w-full bg-emerald-500 hover:bg-emerald-600 disabled:bg-emerald-500/50 disabled:cursor-not-allowed text-white font-medium py-2.5 rounded-xl transition-colors flex items-center justify-center gap-2"
            >
              {loading ? (
                <>
                  <Loader2 size={18} className="animate-spin" />
                  Generating...
                </>
              ) : (profile && profile.subscriptionTier === 'free' && remainingGenerations <= 0) ? (
                <>
                  <Lock size={18} />
                  Limit reached
                </>
              ) : (
                <>
                  <Sparkles size={18} />
                  Generate architecture
                </>
              )}
            </button>
            {error && (
              <div className="mt-4 p-3 bg-red-500/10 border border-red-500/20 rounded-xl text-red-400 text-sm">
                {error}
              </div>
            )}
          </div>
        </div>

        {/* Output Section */}
        <div className="lg:col-span-8">
          {project ? (
            <motion.div 
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              className="space-y-6"
            >
              {/* Project Header */}
              <div className="bg-[#16191f] rounded-2xl border border-white/5 p-6 shadow-xl">
                <h2 className="text-3xl font-semibold text-white mb-4 tracking-tight">
                  {project.project_name}
                </h2>
                
                <div className="flex flex-wrap gap-2">
                  {project.tech_stack.map((tech, i) => (
                    <span key={i} className="px-3 py-1 bg-white/5 border border-white/10 rounded-full text-xs font-medium text-emerald-300 flex items-center gap-1.5">
                      <Layers size={14} />
                      {tech}
                    </span>
                  ))}
                </div>
              </div>

              {/* File Structure */}
              <div className="bg-[#16191f] rounded-2xl border border-white/5 p-6 shadow-xl">
                <h3 className="text-lg font-medium text-white mb-4 flex items-center gap-2">
                  <FolderTree size={18} className="text-emerald-400" />
                  Project Structure
                </h3>
                <pre className="bg-[#0f1115] border border-white/10 rounded-xl p-4 overflow-x-auto text-sm font-mono text-slate-300">
                  {project.file_structure}
                </pre>
              </div>

              {/* Core Logic */}
              <div className="bg-[#16191f] rounded-2xl border border-white/5 p-6 shadow-xl space-y-6">
                <h3 className="text-lg font-medium text-white flex items-center gap-2">
                  <FileCode2 size={18} className="text-emerald-400" />
                  Core Logic
                </h3>
                
                {project.core_logic.map((file, i) => (
                  <div key={i} className="space-y-3">
                    <div className="flex items-center gap-3">
                      <span className="px-2 py-1 bg-emerald-500/10 text-emerald-400 text-xs font-mono rounded border border-emerald-500/20">
                        {file.file_name}
                      </span>
                      <span className="text-sm text-slate-400">{file.description}</span>
                    </div>
                    <pre className="bg-[#0f1115] border border-white/10 rounded-xl p-4 overflow-x-auto text-sm font-mono text-slate-300">
                      <code>{file.code_snippet}</code>
                    </pre>
                  </div>
                ))}
              </div>

              {/* Setup Guide */}
              <div className="bg-[#16191f] rounded-2xl border border-white/5 p-6 shadow-xl">
                <h3 className="text-lg font-medium text-white mb-4 flex items-center gap-2">
                  <Terminal size={18} className="text-emerald-400" />
                  Setup Guide
                </h3>
                <ol className="space-y-3">
                  {project.setup_guide.map((step, i) => (
                    <li key={i} className="flex gap-3 text-sm">
                      <span className="flex-shrink-0 w-6 h-6 rounded-full bg-white/5 border border-white/10 flex items-center justify-center text-xs font-medium text-slate-400">
                        {i + 1}
                      </span>
                      <span className="pt-0.5">{step}</span>
                    </li>
                  ))}
                </ol>
              </div>

            </motion.div>
          ) : (
            <div className="h-full min-h-[400px] flex flex-col items-center justify-center text-slate-500 border-2 border-dashed border-white/5 rounded-2xl">
              <Layers size={48} className="mb-4 opacity-20" />
              <p>Describe an idea to see the architecture</p>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}


