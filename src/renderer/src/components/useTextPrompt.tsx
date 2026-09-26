import { useEffect, useRef, useState } from 'react'
import { NATURES } from '../../../shared/constants'
import type { Nature } from '../../../shared/types'

type Prompt = { kind: 'text' | 'nature' | 'confirm'; label: string }
type PromptAnswer = string | boolean | null

export function useTextPrompt() {
  const [prompt, setPrompt] = useState<Prompt | null>(null)
  const [value, setValue] = useState('')
  const input = useRef<HTMLInputElement | null>(null)
  const natureSelect = useRef<HTMLSelectElement | null>(null)
  const confirmButton = useRef<HTMLButtonElement | null>(null)
  const resolve = useRef<((answer: PromptAnswer) => void) | null>(null)
  useEffect(() => () => { resolve.current?.(null) }, [])
  useEffect(() => {
    if (prompt?.kind === 'text') input.current?.focus()
    if (prompt?.kind === 'nature') natureSelect.current?.focus()
    if (prompt?.kind === 'confirm') confirmButton.current?.focus()
  }, [prompt])
  const finish = (answer: PromptAnswer) => {
    const done = resolve.current
    resolve.current = null
    setPrompt(null)
    done?.(answer)
  }
  const ask = (message: string): Promise<string | null> => new Promise((done) => {
    resolve.current?.(null)
    resolve.current = (answer) => done(typeof answer === 'string' ? answer : null)
    setValue(''); setPrompt({ kind: 'text', label: message })
  })
  const askNature = (message: string): Promise<Nature | null> => new Promise((done) => {
    resolve.current?.(null)
    resolve.current = (answer) => done(typeof answer === 'string' && NATURES.includes(answer as Nature) ? answer as Nature : null)
    setValue(''); setPrompt({ kind: 'nature', label: message })
  })
  const askConfirm = (message: string): Promise<boolean> => new Promise((done) => {
    resolve.current?.(null)
    resolve.current = (answer) => done(answer === true)
    setPrompt({ kind: 'confirm', label: message })
  })
  const modal = prompt === null ? null : <div className="modal-backdrop"><form className="modal" role="dialog" aria-modal="true" aria-label={prompt.kind === 'text' ? 'Enter observed value' : prompt.kind === 'nature' ? 'Select observed nature' : 'Confirm breed step'} onSubmit={(event) => {
    event.preventDefault()
    if (prompt.kind !== 'confirm' && !value.trim()) return
    finish(prompt.kind === 'confirm' ? true : value.trim())
  }}>
    {prompt.kind === 'text' ? <label>{prompt.label}<input ref={input} value={value} onChange={(event) => setValue(event.target.value)} /></label>
      : prompt.kind === 'nature' ? <label>{prompt.label}<select ref={natureSelect} value={value} onChange={(event) => setValue(event.target.value)}><option value="">Select nature…</option>{NATURES.map((nature) => <option key={nature} value={nature}>{nature}</option>)}</select></label>
        : <p>{prompt.label}</p>}
    <div className="modal-actions"><button type="button" onClick={() => finish(null)}>Cancel</button><button ref={confirmButton} className="primary" disabled={prompt.kind !== 'confirm' && !value.trim()}>{prompt.kind === 'confirm' ? 'Continue' : 'OK'}</button></div>
  </form></div>
  return { ask, askNature, askConfirm, modal }
}
