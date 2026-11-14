# Frontend handoff — IncidentLab

Дата проверки: 14 ноября 2026. Ветка: `feat/ui-demo`. Основа: backend `83812c6` из `feat/engine-coach`, bootstrap `78c615b`. Контракт v1, backend, API, общие зависимости и конфиги сохранены без изменений со стороны frontend.

## Что реализовано

- Стартовая область, карточка Catalog slowdown, собственная SVG-монограмма IL. Интерфейс на английском, системные шрифты, отметка Simulated environment.
- Единое рабочее пространство: модельные часы, pause/play, скорости 1/2/4/8×, автоматическая остановка на checkpoint из ScenarioDefinition, переход к произвольному времени и Run to end.
- Метрики клиентов отдельно от попыток БД; successful/failed/pending всегда рядом. График строится из `RunView.series`, схема API → очередь/воркеры → database использует вычисленные очереди и активные операции. Latency подписана successful only.
- Request explorer: поиск по ID, фильтры статусов, страницы по 8 запросов и полный связанный trace выбранного запроса, включая timeout/retry/late response.
- Три управления из ScenarioDefinition, одна Intervention на фактическое изменение, журнал решений. Повторный клик по тому же значению не дублирует запись.
- Сохранение и восстановление SavedSession v1. На диск записываются спецификации и курсоры, а не вычисленные trace. Проверка схемы и ограничений движка защищает от повреждённых или устаревших данных.
- У вкладок отдельные снимки localStorage. Ключ ротируется при mount; reload и дублирование наследуют предыдущий снимок, дальнейшие записи независимы. Отказ storage оставляет практику доступной в памяти с объяснением.
- Rewind & branch сохраняет A и создаёт B с тем же seed и только `atMs < checkpointMs`. Просмотр прошлого блокирует редактирование до явного создания новой ветки; просмотренный горизонт хранится как отдельная вкладочная UI-метаинформация.
- Compare attempts заново проигрывает две спецификации до одинакового конца сценария через compareRuns. Таблица и диаграмма содержат исходы клиентов, попытки, повторы, latency и B−A. Уменьшение attempts не подписано как автоматическая победа.
- Coach работает только через POST /api/coach. Есть Hint/Debrief, глубина подсказки, loading, 22-секундный предел ожидания, error/retry и отмена/игнорирование устаревших ответов при смене контекста. AI debrief и Rule-based recap подписаны по source; warning виден. Текст модели выводится обычным React-текстом.
- Namespaced evidence-ссылки открывают правильную ветку и запрос/системное событие. На телефоне доступны быстрые переходы Metrics / Requests / Decide / Coach.

В production нет preview fixtures или скрытой подмены данных. Все результаты получены из настоящего общего движка.

## Выполненные проверки

| Проверка | Результат |
| --- | --- |
| npm run demo | Seed 42 воспроизводит описанные ниже A/B-результаты |
| npm run typecheck | Успешно |
| npm test | 106 тестов в 6 файлах, включая engine/API и 18 frontend-тестов |
| npm run build | Успешная production-сборка страницы и двух API endpoints |
| Chrome, production-сборка | Все 10 групп browser QA прошли, pageErrors: [] |
| Desktop 1440×1080 и mobile 360×800 | Проверены; переполнения страницы по горизонтали на 360 px нет |
| git push --dry-run | Push frontend-ветки разрешён |

Browser QA: start → checkpoint → inspect на паузе → intervention → consequence → save A → rewind → B → compare → coach → evidence. Дополнительно проверены double click, reload, две независимые вкладки, повреждённый JSON, запрет редактирования прошлого после reload, HTTP 503 coach, retry, устаревший ответ после смены ветки, настоящий клиентский timeout 22 секунды, безопасный вывод HTML-подобного текста и клавиатурный фокус. HTTP 503/late response/HTML-подобный ответ подменялись только в browser test runner для проверки состояний клиента.

Реальный локальный POST /api/coach вернул **source=rules**, интерфейс показал **Rule-based recap**. Это проверка интеграции и fallback. Реальный NVIDIA inference в этой frontend-среде не проверялся.

## Проверенный эксперимент

Обе ветки: seed 42, checkpoint 20000 ms, общий горизонт 120000 ms. A: `set-api-replicas=4` на checkpoint. B: `set-max-attempts=1` на checkpoint, действие A не унаследовано.

| Метрика | A | B | B−A |
| --- | ---: | ---: | ---: |
| Уникальные запросы | 960 | 960 | 0 |
| Successful | 120 | 709 | +589 |
| Failed | 800 | 248 | −552 |
| Pending | 40 | 3 | −37 |
| Попытки БД | 2588 | 987 | −1601 |

Это результаты данного симулированного кейса, не измерения production-системы.

## Запуск и материалы

```sh
npm ci
npm run dev
```

Открыть http://localhost:3000. Для production: `npm run build`, затем `npm start`.

[Runbook на 60–90 секунд](runbook.md) · [Browser runner](../../tests/ui/browser-flow.mjs) · [Старт](screenshots/welcome.png) · [Workspace](screenshots/workspace-overview.png) · [Сравнение](screenshots/comparison.png) · [Mobile](screenshots/mobile.png).

Browser runner использует внешний установленный Playwright runtime и Chrome; shared package.json/lock не менялись. В этой среде запущен Chrome из ОС через временный Playwright runtime. Приложение от QA runtime не зависит.

## Что остаётся команде

Локальных блокеров интеграции frontend/backend нет. Для сдачи интегратору нужны merge ветки, публичный production deploy без авторизации и настройка server-only NVIDIA environment, если нужен настоящий AI debrief. Проверка на физическом проекторе и запись резервного видео ещё не выполнялись. README принадлежит backend-owner; его упоминание scaffold следует обновить при общей интеграции.
