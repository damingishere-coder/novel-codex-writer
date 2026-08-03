# 第001章 memory_patch

> patch_id：`chapter-001-v1`

```json
{
  "schema_version": 1,
  "patch_id": "chapter-001-v1",
  "chapter": 1,
  "summary": "沈砚收到死亡预告，确认信纸来自照夜号，并与容七建立临时合作。",
  "ending_state": "沈砚仍在旧港写信铺并持有匿名信；第九盏镇雾灯已经熄灭。",
  "operations": [
    {
      "action": "upsert",
      "record": {
        "id": "character-shenyan-current",
        "category": "character",
        "status": "active",
        "importance": "high",
        "entities": ["沈砚"],
        "tags": ["死亡预告", "匿名信"],
        "content": "沈砚已确认匿名信不是普通恶作剧，当前持有原信，并知道自己被预告将于明日子时在第十三号码头溺亡。"
      }
    },
    {
      "action": "upsert",
      "record": {
        "id": "relationship-shenyan-rongqi-truce",
        "category": "relationship",
        "status": "tentative",
        "importance": "high",
        "entities": ["沈砚", "容七"],
        "tags": ["临时合作", "不信任"],
        "content": "沈砚与容七建立只持续到明夜的临时合作，但沈砚因信中新增警告而开始怀疑容七。"
      }
    },
    {
      "action": "upsert",
      "record": {
        "id": "foreshadowing-lightkeeper-warning",
        "category": "foreshadowing",
        "status": "active",
        "importance": "critical",
        "entities": ["沈砚", "容七"],
        "tags": ["点灯人", "信件新字"],
        "content": "匿名信新增文字“别相信替你点灯的人”，其真实指向尚未确认。"
      }
    },
    {
      "action": "upsert",
      "record": {
        "id": "timeline-black-tide-lamp-nine",
        "category": "timeline",
        "status": "active",
        "importance": "critical",
        "entities": ["雾港", "镇雾灯"],
        "tags": ["黑潮", "第九盏灯", "无面舟"],
        "content": "黑潮前夜，第九盏镇雾灯已经熄灭，无面舟具备靠岸条件。"
      }
    }
  ]
}
```
