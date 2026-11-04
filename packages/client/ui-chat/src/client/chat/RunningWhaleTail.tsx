/** Decorative brand mark for the running Chat status. */
import { FishLogo } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './ChatView.module.css'

/** Render the product mark while a task is running. */
export function RunningWhaleTail() {
  return <span className={css.runningIcon} aria-hidden="true"><FishLogo size={14} /></span>
}
