<?php
declare(strict_types=1);

function physicalGraphRecordFixture():array
{
    return json_decode(file_get_contents(dirname(__DIR__,3).'/contracts/fixtures/physical_graph_records.json'),true,512,JSON_THROW_ON_ERROR);
}

function physicalGraphRecordScale(array $base,int $count):array
{
    $result=['indices'=>[],'keys'=>[],'checks'=>[]];
    for($i=0;$i<$count;$i++){
        $index=$base['indices'][0];$index['id']="index-$i";$index['tableId']="t-$i";$index['terms'][0]['source']['columnId']="c-$i-1";$index['terms'][1]['source']['columnId']="c-$i-0";
        $key=$base['keys'][0];$key['id']="key-$i";$key['tableId']="t-$i";$key['columns']=["c-$i-1","c-$i-0"];$key['indexId']=$index['id'];
        $check=$base['checks'][0];$check['id']="check-$i";$check['tableId']="t-$i";$check['expressionSql']='"Column.0" > 0';
        $result['indices'][]=$index;$result['keys'][]=$key;$result['checks'][]=$check;
    }
    return $result;
}
