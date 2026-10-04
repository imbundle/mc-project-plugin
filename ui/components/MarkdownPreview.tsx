import React from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

const markdownTypographyClassName = [
  '[&_h1]:mb-4 [&_h1]:mt-0 [&_h1]:text-xl [&_h1]:font-semibold [&_h1]:text-text',
  '[&_h2]:mb-3 [&_h2]:mt-6 [&_h2]:text-lg [&_h2]:font-semibold [&_h2]:text-text',
  '[&_h3]:mb-2 [&_h3]:mt-5 [&_h3]:text-base [&_h3]:font-semibold [&_h3]:text-text',
  '[&_h4]:mb-2 [&_h4]:mt-4 [&_h4]:text-sm [&_h4]:font-semibold [&_h4]:text-text',
  '[&_p]:my-3 [&_p]:leading-6',
  '[&_ul]:my-3 [&_ul]:list-disc [&_ul]:pl-6 [&_ol]:my-3 [&_ol]:list-decimal [&_ol]:pl-6 [&_li]:pl-1',
  '[&_blockquote]:my-4 [&_blockquote]:border-l-2 [&_blockquote]:border-border-subtle [&_blockquote]:pl-4 [&_blockquote]:text-text-muted',
  '[&_a]:text-accent [&_a]:underline [&_a]:underline-offset-2',
  '[&_pre]:my-4 [&_pre]:overflow-x-auto [&_pre]:border [&_pre]:border-border-subtle [&_pre]:bg-surface-sunken [&_pre]:px-3 [&_pre]:py-2 [&_pre]:font-mono [&_pre]:text-xs',
  '[&_code]:rounded-sm [&_code]:bg-surface-sunken [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-xs [&_code]:text-accent',
  '[&_pre_code]:rounded-none [&_pre_code]:bg-transparent [&_pre_code]:px-0 [&_pre_code]:py-0 [&_pre_code]:text-text',
  '[&_table]:my-4 [&_table]:w-full [&_table]:border-collapse',
  '[&_th]:border [&_th]:border-border-subtle [&_th]:bg-surface-raised [&_th]:px-3 [&_th]:py-2 [&_th]:text-left [&_th]:font-semibold',
  '[&_td]:border [&_td]:border-border-subtle [&_td]:px-3 [&_td]:py-2',
  '[&_hr]:my-6 [&_hr]:border-border-subtle',
].join(' ')

/** External http(s) links open in a new tab; relative links render as text (repo files need auth tokens). */
function MarkdownLink({ href, children }: { href?: string; children?: React.ReactNode }) {
  if (href && /^https?:\/\//.test(href)) {
    return (
      <a href={href} target="_blank" rel="noreferrer">
        {children}
      </a>
    )
  }
  return <span>{children}</span>
}

export function MarkdownPreview({ content }: { content: string }) {
  return (
    <div
      data-testid="md-preview"
      className={`bg-surface min-h-0 min-w-0 flex-1 overflow-auto p-4 text-sm text-text ${markdownTypographyClassName}`}
    >
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: MarkdownLink }}>
        {content}
      </ReactMarkdown>
    </div>
  )
}
