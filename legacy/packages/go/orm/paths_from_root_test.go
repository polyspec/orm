package orm_test

import (
	"strings"
	"testing"

	"github.com/polyspec/orm/legacy/packages/go/testcase"
)

// pathTests are the tests of this package that read files of the checkout and run without a database server.
var pathTests = []string{
	"TestBindVectors",
	"TestCanonicalizePadsInListAndRejectsOutOfRangeParam",
	"TestCodeCatalog",
	"TestCompositeCollectionKeyTypedComponentsFromFixture",
	"TestExternalModuleCanImportClient",
	"TestNullableCompositeRowHasNoCollectionKey",
	"TestPadInRepeatsTheLastCompositeTuple",
	"TestPlanCacheBoundedByInListShape",
	"TestPlanCachePagedReadBindsPageValues",
	"TestRecipeAesRotationSqlite",
	"TestRecipeAuditTriggersSqlite",
	"TestRecipeCanonicalNone",
	"TestRecipeCatalogConnectionSqlite",
	"TestRecipeCatalogConnectionSqliteOnly",
	"TestRecipeCodecBytesValueNone",
	"TestRecipeCodecIntegerBeyondI64None",
	"TestRecipeCodecJsonDepthNone",
	"TestRecipeCodecMapKeysNone",
	"TestRecipeCodecNone",
	"TestRecipeCodecNonFiniteValueNone",
	"TestRecipeCodecRawTextNone",
	"TestRecipeCodecStyledUnsetNone",
	"TestRecipeComplexQuerySqlite",
	"TestRecipeCompositeKeysSqlite",
	"TestRecipeConnectionPoolSqlite",
	"TestRecipeConstraintsAndRelationsSqlite",
	"TestRecipeDbspecAddTablesSteps",
	"TestRecipeDbspecApplySqlite",
	"TestRecipeDbspecApplyVerificationErrorsNone",
	"TestRecipeDbspecDialectRefusalNone",
	"TestRecipeDbspecIntrospectMessagesNone",
	"TestRecipeDbspecIntrospectSqlite",
	"TestRecipeDbspecLimitsNone",
	"TestRecipeDbspecLoadSetNone",
	"TestRecipeDbspecPlanCases",
	"TestRecipeDbspecPlanChains",
	"TestRecipeDbspecPlanComparisons",
	"TestRecipeDbspecPlanInvalid",
	"TestRecipeDbspecPlanParse",
	"TestRecipeDbspecReadSetNone",
	"TestRecipeDbspecRenderPhysicalSqlite",
	"TestRecipeDbspecRenderStatementsNone",
	"TestRecipeDbspecRulesNone",
	"TestRecipeDbspecSetDecimalSqlite",
	"TestRecipeDbspecShowCreateIntrospectNone",
	"TestRecipeDefaultSelectSetNone",
	"TestRecipeDsnConnectionSqlite",
	"TestRecipeDsnRejectCheckedNone",
	"TestRecipeDsnRejectNone",
	"TestRecipeDsnRejectParametersNone",
	"TestRecipeExternalAuditSqlite",
	"TestRecipeFilesNone",
	"TestRecipeFulltextSearchSqlite",
	"TestRecipeGeneratorNone",
	"TestRecipeGeneratorScanNone",
	"TestRecipeHashesNone",
	"TestRecipeImmutableWriteSqlite",
	"TestRecipeInvalidNone",
	"TestRecipeModelQueriesChainSqlite",
	"TestRecipeModelQueriesSqlite",
	"TestRecipeModelWritesChainSqlite",
	"TestRecipeNormalizeNone",
	"TestRecipeParameterChunkingSqlite",
	"TestRecipePerformanceGateSqlite",
	"TestRecipePlannerCompileNone",
	"TestRecipePositionsNone",
	"TestRecipeRawTextSqlite",
	"TestRecipeRequestHookSqlite",
	"TestRecipeRuntimeModelEntitiesNone",
	"TestRecipeRuntimeModelPlansNone",
	"TestRecipeSchemaDefinitionNone",
	"TestRecipeSchemaInstallSqlite",
	"TestRecipeSetParseNone",
	"TestRecipeSetsNone",
	"TestRecipeStatementEventsSqlite",
	"TestRecipeStatementRunnerSqlite",
	"TestRecipeUtilsSqlite",
	"TestSavepointReportsFailedEnd",
	"TestStatementFaultCases",
	"TestStatementFaultMySQL",
	"TestStatementFaultPostgres",
	"TestStatementFaultSQLite",
	"TestTransactionReportsFailedRollback",
	"TestTransactionReportsFailedSQLiteModeReset",
}

// TestPathsFromAnyDirectory runs pathTests with the repository root as their working directory instead of the package
// directory: they must pass there too, so they find the files of the checkout at any depth of the working directory (T448).
func TestPathsFromAnyDirectory(t *testing.T) {
	testcase.Start(t)
	pattern := "^(" + strings.Join(pathTests, "|") + ")$"
	output, err := testcase.RunFrom(t, testcase.RepositoryRoot(), pattern)
	if err != nil {
		t.Fatalf("the tests of the checkout files run from the repository root: %v\n%s", err, output)
	}
	if !strings.Contains(output, "--- PASS") {
		t.Fatalf("the tests of the checkout files run from the repository root ran no test\n%s", output)
	}
}
