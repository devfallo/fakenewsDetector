import { useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

const EXAMPLES = [
  'https://www.youtube.com/shorts/xxxxxxxx',
  'https://www.instagram.com/reel/xxxxxxxx',
  'https://example.com/community-post/123'
];
const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL || '').trim();

function apiUrl(path) {
  if (!API_BASE_URL) {
    return path;
  }
  return `${API_BASE_URL.replace(/\/+$/, '')}${path}`;
}

function extractUrlsFromText(text) {
  const matches = String(text || '').match(/https?:\/\/[^\s<>"'`)\]]+/gi) || [];
  const cleaned = matches
    .map((url) => url.replace(/[),.;!?]+$/g, '').trim())
    .filter(Boolean);
  return [...new Set(cleaned)];
}

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

function ResultPanel({ title, payload }) {
  if (!payload) {
    return null;
  }

  if (!payload.ok) {
    return (
      <section className="compare-item">
        <h3>{title}</h3>
        <div className="error">오류: {payload.error || '결과 없음'}</div>
      </section>
    );
  }

  const text = payload.text || '응답이 비어 있습니다.';
  const parsed = parseAnalysis(text);
  const meta = statusMeta(parsed.level);

  return (
    <section className="compare-item">
      <h3>{title}</h3>
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
      <h4 className="raw-title">답변 원문</h4>
      <div className="markdown-result">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
      </div>
    </section>
  );
}

function App() {
  const [installPromptEvent, setInstallPromptEvent] = useState(null);
  const [installMessage, setInstallMessage] = useState('');
  const [largeText, setLargeText] = useState(false);
  const [link, setLink] = useState('');
  const [detectedLinks, setDetectedLinks] = useState([]);
  const [context, setContext] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState('');
  const [dualResults, setDualResults] = useState(null);
  const parsed = result ? parseAnalysis(result) : null;
  const meta = parsed ? statusMeta(parsed.level) : null;
  const hasLink = link.trim().length > 0;

  useEffect(() => {
    const onBeforeInstallPrompt = (event) => {
      event.preventDefault();
      setInstallPromptEvent(event);
    };

    const onAppInstalled = () => {
      setInstallPromptEvent(null);
      setInstallMessage('앱이 홈 화면에 추가되었습니다.');
    };

    window.addEventListener('beforeinstallprompt', onBeforeInstallPrompt);
    window.addEventListener('appinstalled', onAppInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onBeforeInstallPrompt);
      window.removeEventListener('appinstalled', onAppInstalled);
    };
  }, []);

  const onAddToHomeScreen = async () => {
    if (installPromptEvent) {
      installPromptEvent.prompt();
      const choice = await installPromptEvent.userChoice.catch(() => null);
      if (choice?.outcome === 'accepted') {
        setInstallMessage('설치가 진행 중입니다.');
      } else {
        setInstallMessage('설치를 취소했습니다.');
      }
      setInstallPromptEvent(null);
      return;
    }

    const isIos = /iphone|ipad|ipod/i.test(window.navigator.userAgent);
    if (isIos) {
      setInstallMessage('Safari 공유 버튼에서 "홈 화면에 추가"를 선택하세요.');
      return;
    }

    setInstallMessage('이 브라우저에서는 자동 설치 버튼을 지원하지 않습니다.');
  };

  const onSubmit = async (event) => {
    event.preventDefault();
    const trimmedInput = link.trim();
    const urlsFromInput = extractUrlsFromText(trimmedInput);
    const availableLinks = urlsFromInput.length > 0 ? urlsFromInput : detectedLinks;

    if (!trimmedInput) {
      setError('링크를 입력해주세요.');
      return;
    }

    if (availableLinks.length > 1 && !availableLinks.includes(trimmedInput)) {
      setDetectedLinks(availableLinks);
      setError('여러 링크가 감지되었습니다. 아래 태그에서 분석할 링크 1개를 선택해주세요.');
      return;
    }

    const finalLink = availableLinks.includes(trimmedInput)
      ? trimmedInput
      : availableLinks[0] || trimmedInput;

    setLoading(true);
    setError('');
    setResult('');
    setDualResults(null);

    try {
      const response = await fetch(apiUrl('/api/check'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          link: finalLink,
          context: context.trim()
        })
      });

      const data = await response.json();
      if (!response.ok || !data.ok) {
        throw new Error(data.error || '판별 요청에 실패했습니다.');
      }

      if (data.results && typeof data.results === 'object') {
        setDualResults(data.results);
        setResult(
          data.result ||
            data.results?.web?.text ||
            data.results?.api?.text ||
            '응답이 비어 있습니다.'
        );
      } else {
        setResult(data.result || '응답이 비어 있습니다.');
      }
    } catch (err) {
      if (err instanceof Error && /failed to fetch/i.test(err.message)) {
        setError(
          '서버 연결에 실패했습니다. 네트워크 상태 또는 서버 응답 지연(타임아웃)을 확인해주세요.'
        );
      } else {
        setError(err instanceof Error ? err.message : '알 수 없는 오류가 발생했습니다.');
      }
    } finally {
      setLoading(false);
    }
  };

  const onLinkPaste = (event) => {
    const pastedText = event.clipboardData?.getData('text') || '';
    const urls = extractUrlsFromText(pastedText);
    if (urls.length === 0) {
      return;
    }

    event.preventDefault();
    setDetectedLinks(urls);
    setLink(urls[0]);
    setError('');
  };

  const onLinkChange = (event) => {
    const value = event.target.value;
    setLink(value);
    const urls = extractUrlsFromText(value);
    setDetectedLinks(urls.length > 1 ? urls : urls.length === 1 ? [urls[0]] : []);
  };

  const onSelectDetectedLink = (url) => {
    setLink(url);
    setError('');
  };

  return (
    <main className={`page ${largeText ? 'large-text' : ''}`}>
      <section className="card">
        <div className="title-row">
          <div>
            <h1>가짜뉴스 판별기</h1>
            <p className="sub">
              링크를 분석해 Gemini API + Headless 결과를 함께 보여줍니다.
            </p>
          </div>
          <button
            type="button"
            className="secondary-button"
            onClick={() => setLargeText((prev) => !prev)}
            aria-pressed={largeText}
          >
            {largeText ? '기본 글자' : '큰 글자'}
          </button>
        </div>

        <div className="install-box">
          <button type="button" className="install-button" onClick={onAddToHomeScreen}>
            홈 화면에 추가
          </button>
          {installMessage && <p className="install-message">{installMessage}</p>}
        </div>

        <form onSubmit={onSubmit}>
          <label htmlFor="link" className="link-label">콘텐츠 링크 또는 본문 텍스트</label>
          <input
            id="link"
            type="text"
            className="link-input"
            value={link}
            onChange={onLinkChange}
            onPaste={onLinkPaste}
            placeholder="링크만 넣거나, 링크가 포함된 문장을 그대로 붙여넣으세요"
            required
          />

          {detectedLinks.length > 1 && (
            <div className="detected-links">
              <strong>감지된 링크 선택</strong>
              <div className="tag-wrap">
                {detectedLinks.map((item) => (
                  <button
                    key={item}
                    type="button"
                    className={`tag-button ${link.trim() === item ? 'active' : ''}`}
                    onClick={() => onSelectDetectedLink(item)}
                  >
                    {item}
                  </button>
                ))}
              </div>
            </div>
          )}

          {hasLink && (
            <>
              <label htmlFor="context">추가 설명 (선택)</label>
              <textarea
                id="context"
                value={context}
                onChange={(e) => setContext(e.target.value)}
                placeholder="의심되는 부분, 주장 내용 등을 적어주세요"
                rows={4}
              />
            </>
          )}

          <button type="submit" disabled={loading}>
            {loading ? 'Gemini API + Headless 병행 판별 중...' : '가짜뉴스 판별하기'}
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
            {dualResults ? (
              <div className="compare-grid">
                <ResultPanel title="Gemini API 결과" payload={dualResults.api} />
                <ResultPanel title="Playwright Headless 결과" payload={dualResults.web} />
              </div>
            ) : (
              <>
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
                <h3 className="raw-title">답변 원문</h3>
                <div className="markdown-result">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{result}</ReactMarkdown>
                </div>
              </>
            )}
          </article>
        )}
      </section>
    </main>
  );
}

export default App;
