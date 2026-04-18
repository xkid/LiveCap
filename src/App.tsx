import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Mic, Globe, Loader2, StopCircle, Type as TypeIcon } from 'lucide-react';
import { GoogleGenAI, Type } from '@google/genai';

// Initialize Gemini API client lazily
const getAiInstance = (apiKey?: string) => {
  const key = apiKey || localStorage.getItem('gemini_api_key') || process.env.GEMINI_API_KEY;
  if (!key) {
    throw new Error("Gemini API Key is required.");
  }
  return new GoogleGenAI({ apiKey: key });
};

const AVAILABLE_LANGUAGES = [
  'Chinese',
  'English',
  'Japanese',
  'Spanish',
  'French',
  'Korean',
  'German',
];

const AVAILABLE_INPUT_LANGUAGES = [
  { label: 'Auto (System)', value: '' },
  { label: 'English', value: 'en-US' },
  { label: 'Chinese', value: 'zh-CN' },
  { label: 'Japanese', value: 'ja-JP' },
  { label: 'Spanish', value: 'es-ES' },
  { label: 'French', value: 'fr-FR' },
  { label: 'Korean', value: 'ko-KR' },
  { label: 'German', value: 'de-DE' },
];

type TranscriptBlock = {
  id: string;
  originalText: string;
  translations: Record<string, string>;
  isTranslating: boolean;
};

export default function App() {
  const [isListening, setIsListening] = useState(false);
  const [inputLanguage, setInputLanguage] = useState('');
  const [selectedLanguages, setSelectedLanguages] = useState<string[]>(['Chinese', 'English', 'Japanese']);
  const [fontSizeScale, setFontSizeScale] = useState(1);
  const [apiKey, setApiKey] = useState(localStorage.getItem('gemini_api_key') || '');
  const [supported, setSupported] = useState(true);
  
  const [interimTranscript, setInterimTranscript] = useState('');
  const [blocks, setBlocks] = useState<TranscriptBlock[]>([]);
  
  const recognitionRef = useRef<any>(null);
  useEffect(() => {
    // Setup Speech Recognition
    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRecognition) {
      setSupported(false);
      return;
    }

    const recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = inputLanguage || navigator.language || 'en-US'; // Listen using selected or system language

    recognition.onstart = () => {
      setIsListening(true);
    };

    recognition.onresult = (event: any) => {
      let interim = '';
      let final = '';

      for (let i = event.resultIndex; i < event.results.length; ++i) {
        if (event.results[i].isFinal) {
          final += event.results[i][0].transcript;
        } else {
          interim += event.results[i][0].transcript;
        }
      }

      setInterimTranscript(interim);

      if (final.trim() !== '') {
        handleFinalTranscript(final.trim());
      }
    };

    recognition.onerror = (event: any) => {
      console.error('Speech recognition error', event.error);
      if (event.error === 'not-allowed') {
        setIsListening(false);
      }
    };

    recognition.onend = () => {
      // Auto-restart if we are supposed to be listening
      // This helps with continuous dictation as SpeechRecognition can end unexpectedly
      if (isListeningRef.current) {
        recognition.start();
      } else {
        setIsListening(false);
      }
    };

    recognitionRef.current = recognition;

    return () => {
      if (recognitionRef.current) {
        recognitionRef.current.onend = null; // Prevent restart loop when changing language
        recognitionRef.current.stop();
      }
    };
  }, [inputLanguage]);

  // Use a ref for isListening to access inside the onend callback without recreating the effect
  const isListeningRef = useRef(isListening);
  useEffect(() => {
    isListeningRef.current = isListening;
  }, [isListening]);

  const toggleLanguage = (lang: string) => {
    if (selectedLanguages.includes(lang)) {
        if (selectedLanguages.length > 1) {
            setSelectedLanguages(selectedLanguages.filter((l) => l !== lang));
        }
    } else {
      setSelectedLanguages([...selectedLanguages, lang]);
    }
  };

  const toggleListening = () => {
    if (!recognitionRef.current) return;
    
    if (isListening) {
      recognitionRef.current.stop();
      setIsListening(false);
    } else {
      setInterimTranscript('');
      try {
        recognitionRef.current.start();
      } catch (e) {
        console.error("Could not start recognition:", e);
      }
    }
  };
  
  const clearTranscripts = () => {
    setBlocks([]);
    setInterimTranscript('');
  };

  const selectedLanguagesRef = useRef(selectedLanguages);
  useEffect(() => {
    selectedLanguagesRef.current = selectedLanguages;
  }, [selectedLanguages]);

  const handleFinalTranscript = useCallback(async (text: string) => {
    const blockId = Date.now().toString() + Math.random().toString(36).substr(2, 9);
    
    // Add new block keeping at most 2 completed ones
    setBlocks((prev) => {
      const completed = prev.filter(b => !b.isTranslating).slice(-2);
      const pending = prev.filter(b => b.isTranslating);
      return [...completed, ...pending, {
        id: blockId,
        originalText: text,
        translations: {},
        isTranslating: true,
      }];
    });

    const targetLangs = selectedLanguagesRef.current;
    
    if (targetLangs.length === 0) {
       setBlocks((prev) => {
         const updated = prev.map(b => b.id === blockId ? { ...b, isTranslating: false } : b);
         const completed = updated.filter(b => !b.isTranslating).slice(-2);
         const pending = updated.filter(b => b.isTranslating);
         return [...completed, ...pending];
       });
       return;
    }

    try {
      const ai = getAiInstance(apiKey);
      // Build properties for the JSON schema dynamically
      const properties: Record<string, any> = {};
      const required: string[] = [];
      targetLangs.forEach(lang => {
          properties[lang] = { 
            type: Type.STRING, 
            description: `The text translated to ${lang}` 
          };
          required.push(lang);
      });

      const response = await ai.models.generateContent({
        model: "gemini-3-flash-preview", // Using fast flash model for text translation
        contents: `Analyze the following transcribed text. The input might consist of mixed or different languages. Automatically detect the source languages, interpret the core intent and meaning, and translate it smoothly into the specified target languages.
        
Text to analyze and translate:
"${text}"`,
        config: {
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties,
            required,
          },
          systemInstruction: "You are a professional, highly accurate multi-language live translator. Provide ONLY the JSON with translations.",
          temperature: 0.1,
        },
      });

      const jsonStr = response.text?.trim() || '{}';
      let translationsObj = {};
      try {
         translationsObj = JSON.parse(jsonStr);
      } catch (e) {
         console.error("Failed to parse translations:", jsonStr);
      }

      setBlocks((prev) => {
        const updated = prev.map(b => b.id === blockId ? {
          ...b,
          translations: translationsObj,
          isTranslating: false,
        } : b);
        const completed = updated.filter(b => !b.isTranslating).slice(-2);
        const pending = updated.filter(b => b.isTranslating);
        return [...completed, ...pending];
      });

    } catch (error) {
      console.error("Translation error:", error);
      setBlocks((prev) => {
        const updated = prev.map(b => b.id === blockId ? {
          ...b,
          isTranslating: false,
          translations: Object.fromEntries(targetLangs.map(l => [l, "Error translating."]))
        } : b);
        const completed = updated.filter(b => !b.isTranslating).slice(-2);
        const pending = updated.filter(b => b.isTranslating);
        return [...completed, ...pending];
      });
    }
  }, [apiKey]);

  if (!supported) {
    return (
      <div className="min-h-screen bg-transparent flex flex-col items-center justify-center p-6 text-app-text-p selection:bg-app-accent selection:text-app-bg">
        <div className="atmosphere"></div>
        <div className="max-w-md w-full glass-panel rounded-[24px] p-8 text-center flex flex-col items-center">
          <Globe className="w-12 h-12 text-app-accent mb-6 opacity-50 shadow-[0_0_15px_var(--color-app-accent)] rounded-full" />
          <h1 className="text-xl font-[800] uppercase tracking-[1px] mb-4">Browser Not Supported</h1>
          <p className="text-app-text-s leading-relaxed font-serif text-lg">
            Your browser does not support the Web Speech API. Please try using Google Chrome, Edge, or Safari.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-transparent text-app-text-p font-sans selection:bg-app-accent selection:text-app-bg pb-24">
      <div className="atmosphere"></div>
      {/* Header */}
      <header className="sticky top-0 z-20 glass-panel border-x-0 border-t-0 px-6 py-4 lg:py-6 shadow-[0_8px_30px_rgba(0,0,0,0.8)] backdrop-blur-xl">
        <div className="max-w-6xl mx-auto flex flex-col md:flex-row md:items-center justify-between gap-6">
          <div className="flex flex-row items-center gap-6 md:gap-10">
             <div className="flex flex-col gap-1 items-start">
               <h1 className="text-[14px] font-[800] uppercase tracking-[2px] text-app-accent">LinguaVox AI</h1>
               <div className="flex items-center gap-2 mt-1">
                  <span className="text-[10px] uppercase tracking-widest text-app-text-s/70 font-bold whitespace-nowrap">Input:</span>
                  <select 
                    value={inputLanguage}
                    onChange={(e) => setInputLanguage(e.target.value)}
                    disabled={isListening}
                    className="bg-transparent text-[11px] uppercase tracking-wider text-white border-b border-white/20 outline-none focus:border-app-accent appearance-none disabled:opacity-50 font-bold pb-0.5 cursor-pointer max-w-[80px] sm:max-w-none text-ellipsis"
                  >
                    {AVAILABLE_INPUT_LANGUAGES.map(lang => (
                      <option key={lang.value} value={lang.value} className="bg-[#05070a] text-[13px] capitalize tracking-normal">{lang.label}</option>
                    ))}
                  </select>
               </div>
             </div>
             
             {/* Mic Button Moved to Header */}
             <div className="flex bg-black/40 p-1.5 pr-4 rounded-full items-center gap-3 border border-white/5 shadow-inner">
                 <button
                   onClick={toggleListening}
                   className={`group relative flex items-center justify-center w-12 h-12 rounded-full transition-all duration-300 shadow-[0_0_20px_rgba(0,242,255,0.15)] hover:shadow-[0_0_30px_rgba(0,242,255,0.3)] shrink-0 ${
                     isListening 
                       ? 'bg-app-accent text-app-bg' 
                       : 'glass-panel hover:bg-app-glass-hover text-app-accent'
                   }`}
                   title={isListening ? 'Stop Recording' : 'Start Recording'}
                 >
                   {isListening && (
                     <span className="absolute inset-0 rounded-full animate-ping bg-app-accent opacity-20"></span>
                   )}
                   {isListening ? <StopCircle className="w-5 h-5" /> : <Mic className="w-5 h-5" />}
                 </button>
                 <div className="flex flex-col">
                     <span className="text-[10px] font-[800] uppercase tracking-[1px] text-app-text-p leading-none mb-1">
                         {isListening ? 'Recording' : 'Tap to Start'}
                     </span>
                     {isListening && <span className="text-[9px] uppercase tracking-widest text-app-accent animate-pulse font-bold">Live Stream</span>}
                 </div>
             </div>

             {/* Font Size Slider (Desktop) */}
             <div className="hidden lg:flex flex-col gap-1.5 ml-4 items-center">
                 <span className="text-[9px] uppercase tracking-widest text-app-text-s/70 font-bold flex items-center gap-1"><TypeIcon className="w-2.5 h-2.5"/> Text Size</span>
                 <input 
                   type="range" 
                   min="0.5" max="2.5" step="0.1" 
                   value={fontSizeScale}
                   onChange={(e) => setFontSizeScale(parseFloat(e.target.value))}
                   className="w-24 accent-app-accent h-1 bg-white/20 rounded-lg appearance-none cursor-pointer"
                 />
             </div>
             
             {/* API Key Input */}
             <div className="flex flex-col gap-1.5 ml-4 items-center">
                 <span className="text-[9px] uppercase tracking-widest text-app-text-s/70 font-bold">API Key</span>
                 <input 
                   type="password"
                   placeholder="Gemini Key"
                   value={apiKey}
                   onChange={(e) => {
                     setApiKey(e.target.value);
                     localStorage.setItem('gemini_api_key', e.target.value);
                   }}
                   className="w-32 bg-black/40 border border-white/10 rounded-lg px-2 py-1 text-[11px] text-white outline-none focus:border-app-accent"
                 />
             </div>
          </div>
          
          <div className="flex flex-col items-start md:items-end gap-2">
             <span className="text-[10px] uppercase tracking-widest text-app-text-s/70 font-bold hidden md:block">Output Languages</span>
             <div className="flex flex-wrap items-center gap-2 md:justify-end">
               {AVAILABLE_LANGUAGES.map((lang) => {
                 const isSelected = selectedLanguages.includes(lang);
                 return (
                   <button
                     key={lang}
                     onClick={() => toggleLanguage(lang)}
                     className={`glass-pill px-4 py-1.5 rounded-full text-[12px] font-medium transition-colors ${
                       isSelected 
                         ? 'active' 
                         : 'hover:bg-app-glass-hover'
                     }`}
                   >
                     {lang}
                   </button>
                 );
               })}
             </div>
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-6 py-6 flex flex-col gap-8">
        
         {/* Font Size Slider (Mobile/Tablet) */}
         <div className="flex lg:hidden flex-row items-center gap-4 justify-center py-2 glass-panel rounded-full max-w-sm mx-auto px-6">
             <span className="text-[9px] uppercase tracking-widest text-app-text-s/70 font-bold flex items-center gap-1"><TypeIcon className="w-3 h-3"/> Text Size</span>
             <input 
               type="range" 
               min="0.5" max="2.5" step="0.1" 
               value={fontSizeScale}
               onChange={(e) => setFontSizeScale(parseFloat(e.target.value))}
               className="w-32 accent-app-accent h-1 bg-white/20 rounded-lg appearance-none cursor-pointer"
             />
         </div>

         {/* Live Transcription Area (Reversed Order) */}
        <div className="flex flex-col gap-6 w-full max-w-5xl mx-auto">
           
           {/* Queueing / Interim Section (Always on TOP) */}
           <div className="flex flex-col gap-4">
             {/* Interim Transcript */}
             {interimTranscript && (
               <div className="glass-panel rounded-2xl p-6 flex flex-col sm:flex-row sm:items-center gap-4 opacity-100 backdrop-blur-sm w-full border border-app-accent/20 transition-all shadow-[0_0_20px_rgba(0,242,255,0.1)]">
                   <div className="flex items-center gap-3 w-full sm:w-auto border-b sm:border-b-0 border-white/5 pb-2 sm:pb-0 shrink-0">
                     <span className="w-2 h-2 bg-app-accent rounded-full animate-pulse shadow-[0_0_10px_var(--color-app-accent)] shrink-0"></span>
                     <span className="text-[10px] font-[700] uppercase tracking-widest text-app-accent">Listening...</span>
                   </div>
                   <p className="font-sans text-[15px] text-white italic truncate w-full">"{interimTranscript}"</p>
               </div>
             )}

             {/* Queueing Translations */}
             {blocks.filter(b => b.isTranslating).reverse().map((block) => (
               <div key={block.id} className="glass-panel rounded-2xl p-6 flex flex-col sm:flex-row sm:items-center gap-4 opacity-80 backdrop-blur-sm w-full border-t border-white/5">
                   <div className="flex items-center gap-3 w-full sm:w-auto border-b sm:border-b-0 border-white/5 pb-2 sm:pb-0 shrink-0">
                      <Loader2 className="w-4 h-4 animate-spin text-app-accent" />
                      <span className="text-[10px] font-[700] uppercase tracking-widest text-app-text-s">Translating</span>
                   </div>
                   <p className="font-sans text-[15px] text-app-text-p italic truncate w-full">"{block.originalText}"</p>
               </div>
             ))}
           </div>
           
           {/* Completed High-Priority Translations (Reversed: Newest First) */}
           <div className="flex flex-col gap-10 mt-2">
             {[...blocks].filter(b => !b.isTranslating).reverse().map((block, idx) => {
                // Determine scale based on position (newest is largest, oldest is slightly diminished)
                const isLatest = idx === 0;
                return (
                  <div key={block.id} className={`relative glass-panel rounded-[2rem] p-8 md:p-12 flex flex-col items-center justify-center text-center shadow-[0_8px_30px_rgba(0,0,0,0.4)] transition-all ${isLatest ? 'opacity-100' : 'opacity-60 scale-[0.98]'}`}>
                     
                     {/* Original Text (Context) */}
                     <div className="absolute top-6 left-6 flex flex-col gap-1 text-left opacity-60 max-w-xs transition-opacity hover:opacity-100">
                        <span className="text-[10px] font-[700] uppercase tracking-widest text-app-text-s">Detected Input</span>
                        <p className="font-sans text-xs text-app-text-p italic line-clamp-2">"{block.originalText}"</p>
                     </div>

                     {/* Stacked "Subtitles" */}
                     <div className="flex flex-col gap-8 w-full mt-10 md:mt-2">
                        {selectedLanguages.map((lang) => (
                           <div key={lang} className="flex flex-col items-center gap-2">
                              <p className="font-serif leading-tight text-white drop-shadow-[0_4px_12px_rgba(0,0,0,0.8)] transition-all duration-300" style={{ fontSize: isLatest ? `${2.8 * fontSizeScale}rem` : `${1.8 * fontSizeScale}rem` }}>
                                 {block.translations[lang] || '—'}
                              </p>
                           </div>
                        ))}
                     </div>
                  </div>
                );
             })}
           </div>
           
           {blocks.length === 0 && !interimTranscript && (
              <div className="text-center py-20 text-app-text-s glass-panel rounded-[24px]">
                 <Globe className="w-12 h-12 mx-auto mb-4 opacity-30 text-app-accent" />
                 <p className="font-serif text-lg opacity-70">Your translations will appear here...</p>
                 <p className="text-[11px] font-[700] uppercase tracking-widest mt-4 opacity-50">Press tap to start in header to begin</p>
              </div>
           )}
        </div>
        
      </main>
    </div>
  );
}

