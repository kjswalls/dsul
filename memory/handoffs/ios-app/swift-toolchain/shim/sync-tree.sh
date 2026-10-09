#!/bin/bash
# Copies the app's non-UI sources and the hosted tests into the shim, adding
# FoundationNetworking for Linux.
set -e
S=$(dirname "$0")
I=/home/claude/dsul/ios
rm -f $S/Sources/Dsul/*.swift $S/Tests/DsulTests/*.swift
for f in Data/APIClient.swift Data/PlannerSync.swift Model/SamplePlanner.swift Model/ItemAccessors.swift \
         Model/SampleData.swift Item/ItemSheetModel.swift App/AppConfig.swift Schedule/ScheduleDrag.swift \
         Today/TodayLayout.swift; do
  { printf '#if canImport(FoundationNetworking)\nimport FoundationNetworking\n#endif\n'; cat $I/Dsul/$f; } > $S/Sources/Dsul/$(basename $f)
done
# AuthError, from AuthStore.swift (which needs CryptoKit).
awk '/^enum AuthError/{p=1} p{print} p&&/^}/{exit}' $I/Dsul/Auth/AuthStore.swift > $S/Sources/Dsul/AuthErrorShim.swift
for f in ItemEditTests ItemSheetTests ItemVerbsTests PlannerSyncTests SamplePlannerTests AccountAPITests; do
  { printf '#if canImport(FoundationNetworking)\nimport FoundationNetworking\n#endif\n'; cat $I/DsulTests/$f.swift; } > $S/Tests/DsulTests/$f.swift
done
# PlannerFormat's row words, from ItemRow.swift (a SwiftUI file).
{ printf 'import DsulCore\nimport Foundation\n'; awk '/^extension PlannerFormat/{p=1} p{print} p&&/^}/{exit}' $I/Dsul/Today/ItemRow.swift; } > $S/Sources/Dsul/PlannerFormatShim.swift
