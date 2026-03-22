<?php

declare(strict_types=1);

class Zynqa_Sniffs_Files_InstallSchemaUsageSniff implements PHP_CodeSniffer\Sniffs\Sniff
{
    public function register()
    {
        return [T_OPEN_TAG];
    }

    public function process(PHP_CodeSniffer\Files\File $phpcsFile, $stackPtr)
    {
        $fileName = str_replace('\\', '/', $phpcsFile->getFilename());
        if (substr($fileName, -24) !== '/Setup/InstallSchema.php') {
            return;
        }

        $phpcsFile->addError(
            'Use declarative schema (db_schema.xml) instead of InstallSchema scripts.',
            $stackPtr,
            'DeprecatedInstallSchema'
        );
    }
}
