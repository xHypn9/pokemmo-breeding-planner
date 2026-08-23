import type { DesktopApi } from '../../shared/ipc'

declare global { interface Window { desktopApi: DesktopApi } }
export {}
