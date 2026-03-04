import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

const EXAMPLES = [
  'https://www.youtube.com/shorts/xxxxxxxx',
  'https://www.instagram.com/reel/xxxxxxxx',
  'https://example.com/community-post/123'
];

function parseAnalysis(text) {
  const verdictMatch = text.match(/판정\s*[:：]\s*\[?([^\]\n]+)\]?/i);
  const confidenceMatch = text.match(/신뢰도\s*[:：]\s*\[?(\d{1,3})/i);

  const verdict = verdictMatch ? verdictMatch[1].trim() : '판별불가';
  const confidence = confidenceMatch ? Math.max(0, Math.min(100, Number(confidenceMatch[1]))) : null;

  const hasReal = /진짜뉴스|사실|true/i.test(verdict);
  const hasFake = /가짜뉴스|허위|false/i.test(verdict);

  if (hasFake && (confidence === null || confidence >= 70)) {
    return { verdict, confidence, level: 'fake' };
  }
  if (hasReal && (confidence === null || confidence >= 70)) {
    return { verdict, confidence, level: 'real' };
  }
  return { verdict, confidence, level: 'unclear' };
}

function statusMeta(level) {
  if (level === 'real') {
    return { label: '진짜뉴스 가능성 높음', icon: 'OK', tone: 'green' };
  }
  if (level === 'fake') {
    return { label: '가짜뉴스 가능성 높음', icon: 'X', tone: 'red' };
  }
  return { label: '애매함 / 추가 확인 필요', icon: '!', tone: 'yellow' };
}

function App() {
  const [link, setLink] = useState('');
  const [context, setContext] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState('');
  const parsed = result ? parseAnalysis(result) : null;
  const meta = parsed ? statusMeta(parsed.level) : null;

  const onSubmit = async (event) => {
    event.preventDefault();
    if (!link.trim()) {
      setError('링크를 입력해주세요.');
      return;
    }

    setLoading(true);
    setError('');
    setResult('');

    try {
      const response = await fetch('/api/check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          link: link.trim(),
          context: context.trim()
        })
      });

      const data = await response.json();
      if (!response.ok || !data.ok) {
        throw new Error(data.error || '판별 요청에 실패했습니다.');
      }

      setResult(data.result || '응답이 비어 있습니다.');
    } catch (err) {
      setError(err instanceof Error ? err.message : '알 수 없는 오류가 발생했습니다.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="page">
      <section className="card">
        <h1>가짜뉴스 판별기</h1>
        <p className="sub">커뮤니티/숏츠/릴스 링크를 붙여넣으면 Gemini 웹에서 판별 결과를 받아옵니다.</p>

        <form onSubmit={onSubmit}>
          <label htmlFor="link">콘텐츠 링크</label>
          <input
            id="link"
            type="url"
            value={link}
            onChange={(e) => setLink(e.target.value)}
            placeholder="https://..."
            required
          />

          <label htmlFor="context">추가 설명 (선택)</label>
          <textarea
            id="context"
            value={context}
            onChange={(e) => setContext(e.target.value)}
            placeholder="의심되는 부분, 주장 내용 등을 적어주세요"
            rows={4}
          />

          <button type="submit" disabled={loading}>
            {loading ? 'Gemini 웹에서 판별 중...' : '가짜뉴스 판별하기'}
          </button>
        </form>

        <div className="examples">
          예시 링크:
          {EXAMPLES.map((item) => (
            <code key={item}>{item}</code>
          ))}
        </div>

        {error && <div className="error">오류: {error}</div>}

        {result && (
          <article className="result">
            <h2>판별 결과</h2>
            {parsed && meta && (
              <section className={`status-board ${meta.tone}`}>
                <div className="status-icon">{meta.icon}</div>
                <div className="status-content">
                  <strong>{meta.label}</strong>
                  <div className="status-metrics">
                    <span>판정: {parsed.verdict}</span>
                    <span>신뢰도: {parsed.confidence === null ? '미제공' : `${parsed.confidence}%`}</span>
                  </div>
                </div>
              </section>
            )}
            <div className="markdown-result">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{result}</ReactMarkdown>
            </div>
          </article>
        )}
      </section>
    </main>
  );
}

export default App;
