import { readEnv } from './lib/env.js'
import { supabase } from './lib/supabaseClient.js'
import './App.css'

export default function App() {
  const { missing, isConfigured } = readEnv()

  return (
    <main className="smoke">
      <h1>Secure Exam Portal</h1>
      <p className="tag">
        M1 foundation smoke test. No product features are implemented in this milestone.
      </p>
      <ul className="checks">
        <li>React, Vite, and JSX: rendering</li>
        <li>Supabase client: {supabase ? 'initialized with the anon key' : 'not initialized'}</li>
        <li>
          Frontend environment: {isConfigured ? 'configured' : `missing ${missing.join(', ')}`}
        </li>
      </ul>
    </main>
  )
}
