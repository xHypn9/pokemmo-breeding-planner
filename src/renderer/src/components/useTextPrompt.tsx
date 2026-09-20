import { useEffect, useRef, useState } from 'react'

export function useTextPrompt() {
  const [label, setLabel] = useState<string | null>(null)
  const [value, setValue] = useState('')
  const resolve = useRef<((value: string | null) => void) | null>(null)
  useEffect(() => () => { resolve.current?.(null) }, [])
  const finish = (answer: string | null) => { resolve.current?.(answer); resolve.current = null; setLabel(null) }
  const ask = (message: string): Promise<string | null> => new Promise((done) => {
    resolve.current?.(null); resolve.current = done; setValue(''); setLabel(message)
  })
  const modal = label === null ? null : <div className="modal-backdrop"><form className="modal" onSubmit={(event) => { event.preventDefault(); finish(value.trim()) }}>
    <label>{label}<input autoFocus value={value} onChange={(event) => setValue(event.target.value)} /></label>
    <div className="modal-actions"><button type="button" onClick={() => finish(null)}>Cancel</button><button className="primary" disabled={!value.trim()}>OK</button></div>
  </form></div>
  return { ask, modal }
}
